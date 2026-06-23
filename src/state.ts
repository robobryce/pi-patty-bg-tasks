/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot } from "./types.ts";

export class BackgroundRegistry {
    /** Active jobs keyed by generated id. */
    jobs = new Map<string, Job>();
    /** Transient foreground slots keyed by toolCallId. */
    foreground = new Map<string, ForegroundSlot>();
    /** Monotonic counter for job-id generation. */
    counter = 0;
    /** Set while a foreground bash invocation is mid-flight; cleared on completion or Ctrl+Shift+B. */
    activeToolCallId: string | null = null;
    /** Job awaiting a decision via `job_decide`. */
    pendingDecisionJobId: string | undefined;

    /** Whether tmux is available for the tmux-backed bash backend. */
    tmuxAvailable = false;
    /** Whether the tmux-unavailable warning has been shown this session. */
    tmuxWarningShown = false;

    /**
     * Whether pi is running non-interactively (print/`-p` mode, or stdin is not
     * a TTY). When true the bash tool does NOT auto-background on timeout —
     * it runs the command to completion instead.
     */
    nonInteractive = false;

    /** Lifetime counters for terminal jobs. */
    completedCount = 0;
    failedCount = 0;
    /** Total jobs ever started in this session. */
    totalStarted = 0;
    /** Sum of terminal-job durations in ms — used by `jobs stats`. */
    totalDurationMs = 0;

    /** Recent terminal jobs kept for `jobs output` lookups. */
    recentTerminal: Job[] = [];
}
