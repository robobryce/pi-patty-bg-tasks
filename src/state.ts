/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot } from "./types.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    foreground = new Map<string, ForegroundSlot>();
    counter = 0;
    activeToolCallId: string | null = null;
    pendingDecisionJobId: string | undefined;

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** Last rendered sidebar content — used to skip redundant widget updates. */
    lastSidebarContent: string | undefined = undefined;

    /** Finished jobs awaiting a coalesced completion notice (see notify.ts).
     *  Buffered so a burst of completions surfaces as one summary, not a wall. */
    pendingFinished: Job[] = [];
    /** Open coalescing window for pendingFinished; one flush per window. */
    finishedFlushTimer: NodeJS.Timeout | undefined = undefined;
}
