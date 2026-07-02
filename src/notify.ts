/**
 * Coalesced background-job notices.
 *
 * Background jobs and monitors finish at all sorts of times during a long agent
 * turn. Sent individually, their notices queue in Pi and dump as a WALL after
 * the agent's next reply — "10 [job-finished] lines all at once, long after they
 * finished." So instead we accumulate every completion + monitor-terminal notice
 * and flush ONE summary at the **turn boundary** (agent_end). A whole turn's
 * worth — however spread out — collapses into a single line. While the agent is
 * idle, a short fallback timer coalesces and flushes instead.
 *
 * Monitor *stream* events (matched log lines) are NOT routed here — they carry
 * data the agent is actively watching and stay live. Only the terminal/status
 * notices (stream ended / stopped / failed) and job completions coalesce.
 *
 * Jobs whose output was already consumed (e.g. via a jobs attach) never enqueue.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    EVENT,
    JOB_FINISH_COALESCE_MS,
    type Job,
    type MonitorEnd,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatNotices } from "./notice.ts";

/** Queue a finished job for the next coalesced notice. */
export function enqueueFinished(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    job: Job
): void {
    if (job.outputConsumed) return; // already surfaced via attach
    // Stamp the finish time now (≈ completion) so the reported duration isn't
    // inflated by however long the notice waits for the turn boundary.
    job.endedAt ??= Date.now();
    reg.pendingFinished.push(job);
    armIdleFlush(reg, pi, ctx);
}

/** Queue a monitor's terminal notice (stream ended / stopped / failed). */
export function enqueueMonitorEnd(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext,
    end: MonitorEnd
): void {
    reg.pendingMonitorEnds.push(end);
    armIdleFlush(reg, pi, ctx);
}

/**
 * Arm the fallback flush — but ONLY while the agent is idle. Mid-turn, notices
 * accumulate and flush together at agent_end (see noteAgentEnd), so a long turn
 * full of finishes yields one summary instead of a wall.
 */
function armIdleFlush(reg: BackgroundRegistry, pi: ExtensionAPI, ctx: UiContext): void {
    if (reg.agentBusy) return;
    if (reg.noticeFlushTimer) return;
    const timer = setTimeout(() => flushNotices(reg, pi, ctx), JOB_FINISH_COALESCE_MS);
    (timer as NodeJS.Timeout).unref();
    reg.noticeFlushTimer = timer;
}

/**
 * Agent started a turn: drain anything still pending (in case a previous turn
 * threw before its agent_end and stranded notices), then hold new notices until
 * this turn ends. The drain is a no-op on the happy path (buffers empty).
 */
export function noteAgentStart(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    flushNotices(reg, pi, ctx);
    reg.agentBusy = true;
    clearFlushTimer(reg);
}

/** Agent finished a turn: flush everything that accumulated as one summary. */
export function noteAgentEnd(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    reg.agentBusy = false;
    flushNotices(reg, pi, ctx);
}

/** Flush the pending batch as one notice. No-op when empty. */
export function flushNotices(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    clearFlushTimer(reg);
    const jobs = reg.pendingFinished;
    const monitors = reg.pendingMonitorEnds;
    if (jobs.length === 0 && monitors.length === 0) return;
    reg.pendingFinished = [];
    reg.pendingMonitorEnds = [];

    const { content, level } = formatNotices(jobs, monitors);

    // Runs from a timer / event: a session reload/fork/switch can stale the ctx,
    // so guard rather than throw uncaught.
    try {
        ctx.ui.notify(content, level);
        pi.sendMessage(
            {
                customType: EVENT.jobFinished,
                content,
                display: true,
                details: {
                    jobCount: jobs.length,
                    monitorCount: monitors.length,
                    jobs: jobs.map((j) => ({
                        jobId: j.id,
                        status: j.status,
                        exitCode: j.exitCode,
                        command: j.command,
                        logPath: j.logPath,
                    })),
                    monitors: monitors.map((m) => ({ description: m.description, summary: m.summary })),
                },
            },
            // A background notice must NOT wake an idle agent into a new turn —
            // that would spin autonomous loops when the user isn't engaged. The
            // human saw it live via ctx.ui.notify; the agent picks it up at the
            // next turn boundary. Do not change to "steer"/triggerTurn:true.
            { deliverAs: "followUp", triggerTurn: false }
        );
    } catch {
        /* stale ctx after a session switch — drop the notice */
    }
}

/** Cancel any pending notices without flushing (session shutdown). */
export function cancelPendingNotices(reg: BackgroundRegistry): void {
    clearFlushTimer(reg);
    reg.pendingFinished = [];
    reg.pendingMonitorEnds = [];
}

function clearFlushTimer(reg: BackgroundRegistry): void {
    if (reg.noticeFlushTimer) {
        clearTimeout(reg.noticeFlushTimer);
        reg.noticeFlushTimer = undefined;
    }
}
