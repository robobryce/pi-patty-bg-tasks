/**
 * Lifecycle helpers for background jobs.
 *
 * Collects the cross-cutting concerns — completion notification, timeout
 * scheduling, terminal-state marking, and cleanup (kill) — in one place.
 * Monitoring (progress polling, stall detection) lives in monitoring.ts.
 */

import { readdirSync, statSync as fsStatSync, unlinkSync as fsUnlink } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    EVENT,
    MAX_CONCURRENT_JOBS,
    type Job,
    type JobStatus,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { killProcessTree, processExists } from "./spawn.ts";
import { atConcurrencyLimit, forget, renderSidebar } from "./registry.ts";
import { watchStalls } from "./monitoring.ts";
import { formatDuration } from "./format.ts";

// --- Background-job orchestration ----------------------------------------

/** Throw a standard error when no concurrency slot is free. */
export function assertJobSlot(reg: BackgroundRegistry): void {
    if (atConcurrencyLimit(reg)) {
        throw new Error(
            `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                `Kill or wait for existing jobs before starting new ones.`
        );
    }
}

/**
 * Wire a background job's lifecycle: completion promise, abort controller,
 * stall watcher, and the exit→completeJob hand-off. The job must already be in
 * the registry. Returns the job's AbortController so callers can attach extra
 * monitors (e.g. agent_bg's progress poller).
 */
export function startBackgroundJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    job: Job;
    exit: Promise<number | null>;
    shouldNotify?: boolean;
    onExit?: (code: number | null) => void;
}): AbortController {
    ensureCompletionPromise(args.job);
    const jobAc = createJobAbort(args.reg, args.job.id);
    const cancelStall = watchStalls({
        jobId: args.job.id,
        command: args.job.command,
        logPath: args.job.logPath,
        pi: args.pi,
        onOversize: () => terminateJobSilently(args.reg, args.job),
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });
    void args.exit.then((code) => {
        args.onExit?.(code);
        completeJob({
            job: args.job,
            code,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
            shouldNotify: args.shouldNotify,
        });
    });
    renderSidebar(args.reg, args.ctx);
    return jobAc;
}

// --- Terminal-state marking ----------------------------------------------

/**
 * Standard completion flow after a job exits — abortJob → markTerminal →
 * notifyFinished → forget → renderSidebar. Shared by every tool's exit
 * callback (bash, bash_bg, agent_bg) as the canonical termination protocol.
 */
export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    // The caller passes the authoritative Job (the object held in the registry),
    // so no lookup is needed.
    const finished = args.job;
    abortJob(args.reg, finished.id);
    markTerminal(finished, statusFromExit(args.code), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
    }
    forget(args.reg, finished);
    renderSidebar(args.reg, args.ctx);
}

/**
 * Mark a job terminal and resolve its donePromise. Idempotent — already-
 * terminal jobs are ignored. The proc reference is dropped explicitly for GC.
 */
export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** Map an exit code to a JobStatus. null is treated as a signal exit (cancel) → completed. */
export function statusFromExit(code: number | null | undefined): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

/**
 * Create a job's donePromise. This is the entry point that attach/log-wait
 * flows await for a result. Idempotent — does not recreate an existing promise.
 */
export function ensureCompletionPromise(job: Job): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

/**
 * Mark a job "killed" and set the output-consumed flag, so the exit callback
 * does not emit a spurious completion notification on any termination path.
 */
export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    job.outputConsumed = true;
}

/** Kill a job quietly and abort its registered monitors/timers. */
export function terminateJobSilently(reg: BackgroundRegistry, job: Job): void {
    terminateJob(job);
    markKilledSilently(job);
    abortJob(reg, job.id);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
}

/** True when the exit code matches a SIGKILL/SIGTERM pattern — lets callers
 *  expecting a clean exit treat it as an intended cancellation. */
export function isSignalExit(code: number | null | undefined): boolean {
    return code === 137 || code === 143;
}

// --- Per-job abort (cleanup) ---------------------------------------------

/** Create an AbortController for a job. Aborting it cancels all monitors. */
export function createJobAbort(
    reg: BackgroundRegistry,
    jobId: string
): AbortController {
    const existing = reg.jobAborts.get(jobId);
    if (existing) return existing;
    const ac = new AbortController();
    reg.jobAborts.set(jobId, ac);
    return ac;
}

/** Abort all monitors for a job and remove the controller. */
export function abortJob(reg: BackgroundRegistry, jobId: string): void {
    const ac = reg.jobAborts.get(jobId);
    if (ac) {
        ac.abort();
        reg.jobAborts.delete(jobId);
    }
}

/**
 * Kill a job — SIGTERM the live process group if the proc handle is present,
 * otherwise signal the recorded PID directly (covers rehydrated jobs that have
 * no proc handle after session restore).
 */
export function terminateJob(job: Job): void {
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}

// --- Foreground backgrounding --------------------------------------------

/** Move the current foreground command to the background and send the agent a follow-up. */
export function backgroundActiveForeground(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    options?: { notifyAgent?: boolean }
): boolean {
    if (!reg.activeToolCallId) return false;
    const toolCallId = reg.activeToolCallId;
    const slot = reg.foreground.get(toolCallId);
    if (!slot) return false;

    slot.requestPause("manual");
    reg.foreground.delete(toolCallId);
    if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
    renderSidebar(reg, ctx);
    ctx.ui.notify("▶ Backgrounded — continuing.", "info");

    // Cooperative steering (input.ts) delivers the user's own message as the
    // follow-up, so it suppresses this synthetic notice to avoid a duplicate
    // agent message and an extra turn. Ctrl+Shift+B / /bg have no user text and
    // keep it.
    if (options?.notifyAgent === false) return true;

    pi.sendMessage(
        {
            customType: EVENT.background,
            content:
                `Command was manually backgrounded by user. ` +
                `Output is being captured. ` +
                `You can continue working — use the jobs tool to check on it later.`,
            display: true,
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
    return true;
}

// --- Completion notification ---------------------------------------------

/**
 * Notify the agent that a job finished. When outputConsumed is true (e.g. a
 * jobs attach already consumed the output) no notification is sent and the job
 * is only cleaned up. The caller calls registry.forget() right after.
 */
export function notifyFinished(args: {
    job: Job;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): void {
    const { job, pi, ctx } = args;
    if (job.outputConsumed) {
        // Output already consumed — clean up without notifying.
        // registry.forget is handled by the caller.
        return;
    }

    const duration = formatDuration(Date.now() - job.startTime);
    const label = job.name ? `"${job.name}"` : `"${job.command.slice(0, 60)}"`;
    const statusText =
        job.status === "completed"
            ? `Background bash ${label} completed (${duration})`
            : `Background bash ${label} ${job.status} (${duration})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(
        statusText,
        job.status === "completed" ? "info" : "error"
    );

    pi.sendMessage(
        {
            customType: EVENT.jobFinished,
            content:
                `${statusText}${exitCodeText}\n` +
                `Task ID: ${job.id}\n` +
                `Output file: ${job.logPath}`,
            display: true,
            details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
                duration,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "followUp", triggerTurn: false }
    );
}

/**
 * Build the follow-up message that informs the agent a command was
 * backgrounded after a timeout. Keeps a single message shape for all backends.
 */
export function buildTimeoutNotice(args: {
    jobId: string;
    command: string;
    logPath: string;
    timeoutMs: number;
    location: { kind: "pid"; pid: number };
}): { content: string; details: Record<string, unknown> } {
    const where = `PID: ${args.location.pid}`;
    const attachHint =
        `Do NOT use jobs action "attach" on this job — it will block indefinitely.`;
    return {
        content:
            `Command running in background with ID: ${args.jobId}. Output is being written to: ${args.logPath}\n\n` +
            `Command: ${args.command}\n` +
            `${where}\n` +
            `Timed out after: ${formatDuration(args.timeoutMs)}\n\n` +
            `Use the job_decide tool with jobId "${args.jobId}" to decide:\n` +
            `- decision "check": inspect the output first\n` +
            `- decision "keep": let it continue running\n` +
            `- decision "kill": terminate it\n\n` +
            attachHint,
        details: {
            jobId: args.jobId,
            logPath: args.logPath,
            command: args.command,
        },
    };
}

/** Record a timeout decision request and deliver it as an agent follow-up. */
export function requestJobDecision(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    job: Job;
    timeoutMs: number;
    location: { kind: "pid"; pid: number };
}): void {
    args.reg.pendingDecisionJobId = args.job.id;
    const notice = buildTimeoutNotice({
        jobId: args.job.id,
        command: args.job.command,
        logPath: args.job.logPath,
        timeoutMs: args.timeoutMs,
        location: args.location,
    });
    args.pi.sendMessage(
        {
            customType: EVENT.timeout,
            content: notice.content,
            display: true,
            details: notice.details,
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

// --- Helpers -------------------------------------------------------------

/** Verify the cwd actually exists. Throws a clear error if not. */
export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** True for whitespace-only commands. bash silently passes empty commands, so reject them explicitly. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

/**
 * True when the command is eligible for auto-backgrounding. Rejects commands
 * like `sleep` where backgrounding is pointless.
 */
const DISALLOWED_AUTO_BACKGROUND = new Set(["sleep"]);
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND.has(base);
}

/**
 * Reject sleeps of 2 seconds or more. A foreground sleep blocks the user's
 * interactive flow, so long waits must use run_in_background / bash_bg.
 */
export function detectBlockedSleep(command: string): string | null {
    const first =
        command
            .trim()
            .split(/&&|;|\|/)[0]
            ?.trim() ?? "";
    const m = /^sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(first);
    if (!m) return null;
    const secs = parseFloat(m[1]);
    if (secs < 2) return null;
    return first;
}

// --- Rehydration (session restore) ---------------------------------------

/**
 * Validate a job rehydrated from a serialized session entry. If the PID is
 * dead, force the job to a terminal state.
 */
export function reviveAndValidate(
    _reg: BackgroundRegistry,
    job: Job
): "alive" | "completed" {
    if (job.status !== "running") return "completed";
    // A job spawned by a *different* pi process (a full restart, not a /reload)
    // cannot be safely managed — the OS may have recycled its PID, and signalling
    // it would hit an unrelated process group. Only revive jobs from the current
    // process. Job ids are `job-<spawning-pid>-<n>`.
    const spawnedPid = Number.parseInt(job.id.split("-")[1] ?? "", 10);
    if (spawnedPid !== process.pid || !processExists(job.pid)) {
        markTerminal(job, "failed");
        return "completed";
    }
    return "alive";
}

// --- Non-interactive mode detection --------------------------------------

/** Detect whether pi is running non-interactively (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

// --- Cleanup -------------------------------------------------------------

/** Remove background log files older than 24 hours. Scoped to the pi-bg- prefix only. */
export function cleanupStaleRuntimeArtifacts(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let entries;
    try {
        entries = readdirSync("/tmp", { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("pi-bg-")) continue;
        const fullPath = pathJoin("/tmp", entry.name);
        try {
            const { mtimeMs } = fsStatSync(fullPath);
            if (now - mtimeMs > MAX_AGE_MS) fsUnlink(fullPath);
        } catch {
            /* already gone */
        }
    }
}
