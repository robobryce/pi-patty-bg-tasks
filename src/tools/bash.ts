/**
 * `bash` tool override.
 *
 * Single file-descriptor backend (no tmux):
 *   - run_in_background=true spawns immediately and returns a job handle
 *   - foreground commands race completion against backgrounding
 *   - a 2s quick-completion window skips the backgrounding machinery
 *   - Ctrl+Shift+B (manual) or the timeout timer move a command to background
 */

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS,
    MAX_CONCURRENT_JOBS,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    type ForegroundSlot,
    type Job,
    type UiContext,
} from "../types.ts";
import { spawnWithFileOutput, killProcessTree } from "../spawn.ts";
import { pollFileTail } from "../output.ts";
import {
    add,
    nextJobId,
    logPathFor,
    readLogTail,
    renderSidebar,
} from "../registry.ts";
import {
    completeJob,
    createJobAbort,
    detectBlockedSleep,
    ensureCompletionPromise,
    isAutoBackgroundAllowed,
    isBlankCommand,
    isSignalExit,
    requestJobDecision,
    requireExistingCwd,
    terminateJobSilently,
} from "../lifecycle.ts";
import { watchStalls } from "../monitoring.ts";
import { textBlock } from "../format.ts";
import { bashParamSchema } from "./bash-params.ts";

/** UI context + cwd is all this tool needs from the host context. */
type BashCtx = UiContext & { cwd: string };

/** Register the overridden `bash` tool. */
export function registerBashTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    originalBash: ReturnType<typeof createBashTool>
): void {
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description:
            "Run a bash command. Long-running commands auto-background after timeout. " +
            "Set run_in_background=true to start in background immediately. " +
            "Use /bg to manually background a running command.",
        promptSnippet:
            "Run shell commands; long-running commands auto-background or use run_in_background=true",
        promptGuidelines: [
            "Use bash with run_in_background=true when a command is expected to run for a long time.",
            "Check background job status with jobs action='list'.",
            "Read background output with jobs action='output'.",
        ],
        parameters: bashParamSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const p = params as {
                command: string;
                timeout?: number;
                run_in_background?: boolean;
                description?: string;
            };
            const bashCtx = ctx as BashCtx;

            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);

            const sleepMatch = detectBlockedSleep(p.command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash with run_in_background=true for long waits.`
                );
            }

            // Enforce the concurrent-job limit.
            const running = Array.from(reg.jobs.values()).filter(
                (j) => j.status === "running"
            );
            if (running.length >= MAX_CONCURRENT_JOBS) {
                throw new Error(
                    `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                        `Kill or wait for existing jobs before starting new ones.`
                );
            }

            // Explicit background mode — spawn and return immediately.
            if (p.run_in_background) {
                return spawnBackground({
                    toolCallId,
                    command: p.command,
                    name: p.description,
                    cwd: bashCtx.cwd,
                    reg,
                    pi,
                    ctx: bashCtx,
                });
            }

            // Foreground mode — race completion against backgrounding.
            return runForeground({
                toolCallId,
                command: p.command,
                timeoutMs: p.timeout ? p.timeout * 1000 : DEFAULT_TIMEOUT_MS,
                signal,
                onUpdate,
                ctx: bashCtx,
                reg,
                pi,
            });
        },
    });
}

// --- Foreground backend --------------------------------------------------

async function runForeground(args: {
    toolCallId: string;
    command: string;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<unknown> | undefined;
    ctx: BashCtx;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
}): Promise<AgentToolResult<unknown>> {
    const { toolCallId, command, timeoutMs, signal, onUpdate, ctx, reg, pi } =
        args;
    const id = nextJobId(reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command,
        cwd: ctx.cwd,
        logPath,
        signal,
    });

    // Register the foreground slot so Ctrl+Shift+B can find this command.
    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((r) => {
        pauseResolve = r;
    });
    const requestPause = (reason: "manual" | "timeout") => pauseResolve?.(reason);

    const slot: ForegroundSlot = {
        toolCallId,
        command,
        logPath,
        pid: spawned.pid,
        requestPause,
    };
    reg.foreground.set(toolCallId, slot);
    reg.activeToolCallId = toolCallId;

    const job: Job = {
        id,
        command,
        pid: spawned.pid,
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: false,
    };
    add(reg, job);

    // Timeout timer.
    const timeoutTimer = setTimeout(() => {
        if (reg.nonInteractive) return;
        if (!reg.foreground.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killProcessTree(spawned.pid, "SIGTERM");
            return;
        }
        requestPause("timeout");
    }, timeoutMs);
    (timeoutTimer as NodeJS.Timeout).unref();

    let progressPoller: { stop: () => void } | undefined;

    const cleanup = () => {
        progressPoller?.stop();
        clearTimeout(timeoutTimer);
    };

    try {
        // Quick completion window (2s).
        const quickResult = await Promise.race<{ code: number | null } | null>([
            spawned.exit.then((c) => ({ code: c })),
            new Promise<null>((r) => {
                const t = setTimeout(r, QUICK_COMPLETION_MS);
                (t as NodeJS.Timeout).unref();
            }),
        ]);

        if (quickResult !== null) {
            cleanup();
            reg.foreground.delete(toolCallId);
            if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
            reg.jobs.delete(id);
            const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
            if (
                quickResult.code !== 0 &&
                quickResult.code !== null &&
                !isSignalExit(quickResult.code)
            ) {
                throw new Error(
                    output || `Command exited with code ${quickResult.code}`
                );
            }
            return { content: [textBlock(output || "(no output)")], details: undefined };
        }

        // Still running — start progress polling.
        progressPoller = pollFileTail(logPath, (text) => {
            onUpdate?.({ content: [{ type: "text", text }], details: undefined });
        });

        // Race: completion vs backgrounding.
        const race = await Promise.race<
            | { kind: "completed"; code: number | null }
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            spawned.exit.then((c) => ({ kind: "completed" as const, code: c })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);

        if (race.kind === "backgrounded") {
            cleanup();
            reg.foreground.delete(toolCallId);
            reg.activeToolCallId = null;
            job.isBackgrounded = true;
            ensureCompletionPromise(job);

            const jobAc = createJobAbort(reg, id);
            const cancelStall = watchStalls({
                jobId: id,
                command,
                logPath,
                pi,
                onOversize: () => terminateJobSilently(reg, job),
            });
            jobAc.signal.addEventListener("abort", cancelStall, { once: true });

            void spawned.exit.then((code) => {
                completeJob({ job, code, reg, pi, ctx });
            });

            renderSidebar(reg, ctx);
            if (race.reason === "timeout") {
                requestJobDecision({
                    reg,
                    pi,
                    job,
                    timeoutMs,
                    location: { kind: "pid", pid: spawned.pid },
                });
            }

            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${id}\nCommand: ${command}\nPID: ${spawned.pid}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        // Normal completion.
        cleanup();
        reg.foreground.delete(toolCallId);
        if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
        reg.jobs.delete(id);
        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        if (race.code !== 0 && race.code !== null && !isSignalExit(race.code)) {
            throw new Error(output || `Command exited with code ${race.code}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        cleanup();
    }
}

// --- Background backend --------------------------------------------------

function spawnBackground(args: {
    toolCallId: string;
    command: string;
    name?: string;
    cwd: string;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): AgentToolResult<unknown> {
    const id = nextJobId(args.reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command: args.command,
        cwd: args.cwd,
        logPath,
    });

    const job: Job = {
        id,
        name: args.name,
        command: args.command,
        pid: spawned.pid,
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: true,
    };
    ensureCompletionPromise(job);
    add(args.reg, job);

    const jobAc = createJobAbort(args.reg, id);
    const cancelStall = watchStalls({
        jobId: id,
        command: args.command,
        logPath,
        pi: args.pi,
        onOversize: () => terminateJobSilently(args.reg, job),
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });

    void spawned.exit.then((code) => {
        completeJob({ job, code, reg: args.reg, pi: args.pi, ctx: args.ctx });
    });

    renderSidebar(args.reg, args.ctx);
    return {
        content: [
            textBlock(
                `Command running in background with ID: ${id}.${
                    args.name ? ` Name: ${args.name}.` : ""
                } Output is being written to: ${logPath}`
            ),
        ],
        details: undefined,
    };
}
