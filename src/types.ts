/**
 * Type definitions and shared constants for the background-tasks extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const PERSISTED_STATE_SCHEMA_VERSION = 2;

// --- Configuration constants ---
export const DEFAULT_TIMEOUT_MS = 120_000;
export const QUICK_COMPLETION_MS = 2_000;
export const FOREGROUND_TAIL_BYTES = 4_096;
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_LOG_BYTES = 100 * 1024 * 1024;
export const OUTPUT_PREVIEW_CHARS = 12_000;
export const RECENT_TERMINAL_KEEP = 20;
export const MAX_CONCURRENT_JOBS = 16;

export const PREVIEW_CHARS = {
    sidebar: 25,
    taskList: 40,
    detail: 50,
    line: 80,
} as const;

// --- Domain types ---
export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface Job {
    id: string;
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
    outputConsumed?: boolean;
    isBackgrounded: boolean;
}

export type BackgroundReason = "manual" | "timeout";

/** Transient handle for an in-flight foreground bash command, keyed by
 *  toolCallId in the registry. Ctrl+Shift+B and the timeout timer call
 *  requestPause to flip the command into the background. */
export interface ForegroundSlot {
    requestPause: (reason: BackgroundReason) => void;
}

// --- Event types ---
export const EVENT = {
    state: "background-tasks-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    attach: "bg-attach",
    background: "bg-manual",
    agentResume: "agent-resume",
    jobFinished: "job-finished",
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// --- UI context ---
export interface UiContext {
    ui: {
        notify(message: string, level?: "info" | "warning" | "error"): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

export type ToolResult = AgentToolResult<unknown>;
