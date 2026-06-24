/**
 * The job registry — the single point of truth for every running or
 * recently-terminal background job. All CRUD operations live here.
 *
 * On top of the data store, this module renders the in-session sidebar
 * pill bar (`renderSidebar`) and aggregates stats (`getStats`).
 */

import { closeSync, openSync, readSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { formatDuration, truncateTail } from "./format.ts";
import {
    PREVIEW_CHARS,
    RECENT_TERMINAL_KEEP,
    type Job,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { capturePane } from "./proc.ts";
import { TMUX_PANE_LINES } from "./types.ts";

// ─── ID 생성 ────────────────────────────────────────────────────────────────────────────────

export function nextJobId(reg: BackgroundRegistry): string {
    return `job-${process.pid}-${++reg.counter}`;
}

export function logPathFor(jobId: string): string {
    return `/tmp/pi-bg-${jobId}.log`;
}

// ─── 레지스트리 변경 ───────────────────────────────────────────────────────────────────────────

/** Add a brand-new running job. Returns the job (with `donePromise` set). */
export function add(reg: BackgroundRegistry, job: Job): Job {
    reg.jobs.set(job.id, job);
    reg.totalStarted++;
    return job;
}

/**
 * Remove a terminal job from the live map and update lifetime counters.
 * Returns the removed job (or undefined if it wasn't in the map).
 */
export function forget(reg: BackgroundRegistry, job: Job): Job | undefined {
    if (!reg.jobs.delete(job.id)) return undefined;
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") {
        reg.completedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    } else if (job.status === "failed") {
        reg.failedCount++;
        reg.totalDurationMs += terminalDurationMs(job);
    }
    reg.recentTerminal.push(job);
    if (reg.recentTerminal.length > RECENT_TERMINAL_KEEP) {
        reg.recentTerminal.shift();
    }
    return job;
}

/** Look up a job by ID. Falls back to prepending "job-" for the common
 *  LLM-stripping case, and to recent-terminal jobs for completed ones. */
export function findJob(reg: BackgroundRegistry, jobId: string): Job | undefined {
    return (
        reg.jobs.get(jobId) ??
        reg.jobs.get(`job-${jobId}`) ??
        reg.recentTerminal.find((j) => j.id === jobId || j.id === `job-${jobId}`)
    );
}

/** Purge all terminal jobs from in-memory state and delete their log files. */
export function cleanupTerminal(reg: BackgroundRegistry): {
    purged: number;
    bytesReclaimed: number;
} {
    let purged = 0;
    let bytes = 0;
    const deletedLogs = new Set<string>();
    const deleteOnce = (logPath: string): number => {
        if (deletedLogs.has(logPath)) return 0;
        deletedLogs.add(logPath);
        return deleteLogFile(logPath);
    };

    const idsToRemove: string[] = [];
    for (const [id, job] of reg.jobs.entries()) {
        if (job.status !== "running") {
            idsToRemove.push(id);
            bytes += deleteOnce(job.logPath);
            purged++;
        }
    }
    for (const id of idsToRemove) {
        reg.jobs.delete(id);
    }
    // recent-terminal 링도 종료된 잡이므로 로그 파일까지 함께 정리.
    for (const job of reg.recentTerminal) {
        bytes += deleteOnce(job.logPath);
        purged++;
    }
    reg.recentTerminal.length = 0;
    return { purged, bytesReclaimed: bytes };
}

function deleteLogFile(logPath: string): number {
    try {
        const { size } = statSync(logPath);
        unlinkSync(logPath);
        return size;
    } catch {
        return 0;
    }
}

// ─── 사이드바 렌더링 ────────────────────────────────────────────────────────────────────────────────

/**
 * Render the pill-bar status widget and aggregate status-bar text.
 * Call after any state change that affects running-job count.
 */
export function renderSidebar(reg: BackgroundRegistry, ctx: UiContext): void {
    const pills: string[] = [];
    let runningCount = 0;

    for (const job of reg.jobs.values()) {
        if (job.status !== "running") continue;
        runningCount++;
        const duration = formatDuration(Date.now() - job.startTime);
        const icon = "▶";
        const label = job.name ? `${job.name}` : job.id;
        pills.push(
            `${icon} ${label}: ${job.command.slice(0, PREVIEW_CHARS.sidebar)} (${duration})`
        );
    }

    if (pills.length === 0) {
        ctx.ui.setWidget("background-jobs", undefined);
        ctx.ui.setStatus("background-jobs", undefined);
        return;
    }

    ctx.ui.setWidget("background-jobs", pills);

    const parts = [`${runningCount} running`];
    if (reg.completedCount > 0) parts.push(`${reg.completedCount} done`);
    if (reg.failedCount > 0) parts.push(`${reg.failedCount} failed`);
    ctx.ui.setStatus(
        "background-jobs",
        ctx.ui.theme.fg("accent", `▶ ${parts.join(", ")}`)
    );
}

// ─── 통계 ───────────────────────────────────────────────────────────────────────────────────

export interface JobStats {
    totalStarted: number;
    running: number;
    completed: number;
    failed: number;
    killed: number;
    recentTerminal: number;
    averageDurationMs: number;
    totalDurationMs: number;
}

export function getStats(reg: BackgroundRegistry): JobStats {
    let running = 0;
    let killed = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running") running++;
        else if (job.status === "killed") killed++;
    }
    const terminalCount = reg.completedCount + reg.failedCount;
    return {
        totalStarted: reg.totalStarted,
        running,
        completed: reg.completedCount,
        failed: reg.failedCount,
        killed,
        recentTerminal: reg.recentTerminal.length,
        averageDurationMs:
            terminalCount > 0
                ? Math.round(reg.totalDurationMs / terminalCount)
                : 0,
        totalDurationMs: reg.totalDurationMs,
    };
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────────────────

function terminalDurationMs(job: Job): number {
    return Date.now() - job.startTime;
}

// ─── 상태 헬퍼 (툴·단축키에서 사용) ───────────────────────────────────────────────────────

/** True when the job is currently in the running state. */
export function isRunning(job: Job): boolean {
    return job.status === "running";
}

/** 잡의 로그 파일 끝부분만 읽는다. 대용량 파일에서도 O(maxChars)만 읽는다. */
export function readLogTail(job: Job, maxChars: number): string {
    const fileTail = readBoundedTail(job.logPath, maxChars);
    if (fileTail && fileTail.length > 0) return fileTail;
    if (job.tmux) {
        return truncateTail(capturePane(job.tmux.windowId, TMUX_PANE_LINES), maxChars);
    }
    return "(no output yet)";
}

function readBoundedTail(logPath: string, maxChars: number): string | undefined {
    try {
        const { size } = statSync(logPath);
        if (size <= maxChars) return readFileSync(logPath, "utf-8");
        // 테일만 읽기 — 전체 파일을 메모리에 올리지 않는다.
        const fd = openSync(logPath, "r");
        try {
            const buf = Buffer.alloc(maxChars);
            readSync(fd, buf, 0, maxChars, Math.max(0, size - maxChars));
            return `...[truncated, showing last ${maxChars} chars]\n${buf.toString("utf-8")}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }
}
