/**
 * Type definitions and shared constants for the background-tasks extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ─── 직렬화 스키마 버전 ───────────────────────────────────────────────────────────

/** Bump when the Job shape changes incompatibly with old session blobs. */
export const PERSISTED_STATE_SCHEMA_VERSION = 1;

// ─── 설정 상수 ───────────────────────────────────────────────────────────────────────────

/** Default timeout for foreground bash commands (15s, matching Claude Code). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Quick-completion window — commands finishing within this skip the backgrounded path. */
export const QUICK_COMPLETION_MS = 2_000;

/** Tail-read size used by the 1-Hz progress poll to surface live output. */
export const FOREGROUND_TAIL_BYTES = 4_096;

/** Stall-watchdog interval — how often we re-check for prompt stalls / oversize. */
export const STALL_CHECK_INTERVAL_MS = 5_000;

/** Stall-watchdog threshold — output that hasn't grown in this long is suspicious. */
export const STALL_THRESHOLD_MS = 45_000;

/** Tail size for the stall-watchdog prompt-detection regex. */
export const STALL_TAIL_BYTES = 1024;

/** Maximum log file size before the stall watchdog kills the job. */
export const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Background-job output preview size for `jobs output` / `attach`. */
export const OUTPUT_PREVIEW_CHARS = 12_000;

/** Number of recent terminal jobs kept for `jobs output` lookups. */
export const RECENT_TERMINAL_KEEP = 20;

/** Lines captured from a tmux pane when a quick-completion path needs the body. */
export const TMUX_PANE_LINES = 2_000;

/** Tmux completion-poller cadence when the window is in the foreground. */
export const TMUX_FOREGROUND_POLL_MS = 200;

/** Tmux completion-poller cadence when the window is in the background. */
export const TMUX_BACKGROUND_POLL_MS = 500;

/** Display-string previews for jobs in the pill bar, job list, and detail view. */
export const PREVIEW_CHARS = {
    sidebar: 25,
    taskList: 40,
    detail: 50,
    line: 80,
} as const;

// ─── 도메인 타입 ───────────────────────────────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface TmuxContext {
    session: string;
    windowId: string;
    exitCodeFile: string;
    outputFile: string;
    gitRoot: string;
}

/** A tracked background job — running, terminal, or recently terminal. */
export interface Job {
    id: string;
    /** Optional human label set via `bash_bg --name`. */
    name?: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    /** True once the agent has consumed output via attach — suppresses completion notification. */
    outputConsumed?: boolean;
    /** True if running in background; false if foreground (not yet backgrounded). */
    isBackgrounded: boolean;
    /** Tmux-backed jobs attach their window context here. Plain object — survives serialisation. */
    tmux?: TmuxContext;
}

/** Transient handle for a foreground bash invocation — Ctrl+B triggers
 *  `requestPause` to flip the job into background mode mid-flight. */
export interface ForegroundSlot {
    toolCallId: string;
    proc: ChildProcess;
    command: string;
    logPath: string;
    /** Resolves the foreground race when the command should be backgrounded. */
    requestPause: () => void;
}

// ─── 에이전트 follow-up 메시지 타입 ───────────────────────────────────────────────────

export const EVENT = {
    state: "background-tasks-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    attach: "bg-attach",
    agentResume: "agent-resume",
    jobFinished: "job-finished",
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// ─── UI 컨텍스트 (최소) ────────────────────────────────────────────────────────────────

export interface UiContext {
    ui: {
        notify(
            message: string,
            level?: "info" | "success" | "warning" | "error"
        ): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

// ExtensionAPI 툴 시그니처와의 호환을 위한 재export.
export type ToolResult = AgentToolResult<unknown>;
