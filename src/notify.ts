/**
 * Coalesced completion notices for background jobs.
 *
 * A single job that finishes still reads like a one-line notice. But a *burst*
 * of completions (e.g. a batch of fast test runs) used to emit one chat
 * follow-up per job, so N jobs dumped a wall of `[job-finished]` lines all at
 * once after the agent's next message. Here, completions within a short window
 * collapse into ONE summary message — Claude-Code-style "don't nag, surface
 * what matters."
 *
 * Jobs whose output was already consumed (e.g. via a jobs attach) never enqueue.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVENT, JOB_FINISH_COALESCE_MS, type Job, type UiContext } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { LOG_DIR } from "./registry.ts";
import { formatDuration } from "./format.ts";

/**
 * Queue a finished job for a coalesced completion notice. The first job opens a
 * fixed window (leading-edge, so latency is bounded to JOB_FINISH_COALESCE_MS);
 * any job finishing within it joins the same batch and the window flushes once.
 */
export function enqueueFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    job: Job
): void {
    if (job.outputConsumed) return; // already surfaced via attach
    // Stamp the finish time now (≈ completion) so a lone job's reported duration
    // isn't inflated by up to the coalescing window when read at flush time.
    job.endedAt ??= Date.now();
    reg.pendingFinished.push(job);
    if (reg.finishedFlushTimer) return; // window already open
    // The first enqueuer's pi/ctx win for the whole window; both are
    // session-global, so later jobs joining the batch dropping theirs is fine.
    const timer = setTimeout(() => flushFinished(reg, pi, ctx), JOB_FINISH_COALESCE_MS);
    (timer as NodeJS.Timeout).unref();
    reg.finishedFlushTimer = timer;
}

/** Flush the pending batch as one notice. No-op when empty. */
export function flushFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (reg.finishedFlushTimer) {
        clearTimeout(reg.finishedFlushTimer);
        reg.finishedFlushTimer = undefined;
    }
    const jobs = reg.pendingFinished;
    if (jobs.length === 0) return;
    reg.pendingFinished = [];

    const { content, level } = jobs.length === 1 ? formatSingle(jobs[0]) : formatBatch(jobs);

    // Runs from a timer: a session reload/fork/switch can stale the captured
    // ctx, so guard like ensureSidebarTicker rather than throw uncaught.
    try {
        ctx.ui.notify(content, level);
        pi.sendMessage(
            {
                customType: EVENT.jobFinished,
                content,
                display: true,
                details: {
                    count: jobs.length,
                    jobs: jobs.map((j) => ({
                        jobId: j.id,
                        status: j.status,
                        exitCode: j.exitCode,
                        command: j.command,
                        logPath: j.logPath,
                    })),
                },
            },
            // Unlike stall/timeout/monitor events (triggerTurn:true), a "job
            // done" notice must NOT wake an idle agent into a new turn — that
            // would spin autonomous loops when the user isn't engaged. The human
            // already saw it live via ctx.ui.notify; the agent picks it up at the
            // next turn boundary. Do not change to "steer"/triggerTurn:true.
            { deliverAs: "followUp", triggerTurn: false }
        );
    } catch {
        /* stale ctx after a session switch — drop the notice */
    }
}

/** Cancel any open window without flushing (session shutdown). */
export function cancelFinishedFlush(reg: BackgroundRegistry): void {
    if (reg.finishedFlushTimer) {
        clearTimeout(reg.finishedFlushTimer);
        reg.finishedFlushTimer = undefined;
    }
    reg.pendingFinished = [];
}

// --- Formatting ----------------------------------------------------------

type Notice = { content: string; level: "info" | "error" };

/** The familiar single-job line, unchanged from the pre-coalescing behavior. */
function formatSingle(job: Job): Notice {
    const duration = formatDuration((job.endedAt ?? Date.now()) - job.startTime);
    // Not jobLabel(): the id is appended separately below, so the label slot
    // prefers the command over the id to stay human-readable.
    const label = job.name ? `"${job.name}"` : `"${job.command.slice(0, 60)}"`;
    const exitText =
        job.exitCode !== undefined && job.exitCode !== 0 ? ` (exit ${job.exitCode})` : "";
    const statusText =
        job.status === "completed"
            ? `Background bash ${label} completed in ${duration}`
            : `Background bash ${label} ${job.status} in ${duration}${exitText}`;
    return {
        content: `${statusText} · ${job.id} · output: ${job.logPath}`,
        level: job.status === "completed" ? "info" : "error",
    };
}

/** One grouped summary for a burst: completed ids, then failed/killed ids with
 *  exit codes. Failures make the whole notice an error so they stay prominent. */
function formatBatch(jobs: Job[]): Notice {
    const completed = jobs.filter((j) => j.status === "completed");
    const failed = jobs.filter((j) => j.status !== "completed");

    const parts: string[] = [];
    if (completed.length > 0) {
        parts.push(`${completed.length} completed (${completed.map((j) => j.id).join(", ")})`);
    }
    if (failed.length > 0) {
        const ids = failed
            .map((j) => (j.exitCode !== undefined && j.exitCode !== 0 ? `${j.id} exit ${j.exitCode}` : j.id))
            .join(", ");
        parts.push(`${failed.length} failed (${ids})`);
    }
    return {
        content: `${jobs.length} background jobs finished — ${parts.join(", ")}. Outputs in ${LOG_DIR}/`,
        level: failed.length > 0 ? "error" : "info",
    };
}
