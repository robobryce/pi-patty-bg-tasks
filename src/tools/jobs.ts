/**
 * `jobs` 툴 — 백그라운드 잡 관리.
 *
 * 액션:
 *   - list: 모든 잡 (현재 + 최근 종료) 출력
 *   - output: 특정 잡의 로그 꼬리 읽기
 *   - kill: 특정 잡 종료
 *   - attach: 잡이 끝날 때까지 기다린 뒤 출력 반환
 *   - search: 정규식으로 모든 잡 출력 검색 (v0.2 신규)
 *   - cleanup: 종료된 잡 모두 제거 (v0.2 신규)
 *   - stats: 집계 메트릭 (v0.2 신규)
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    OUTPUT_PREVIEW_CHARS,
    PREVIEW_CHARS,
    type UiContext,
} from "../types.ts";
import { processExists } from "../proc.ts";
import {
    cleanupTerminal,
    findJob,
    getStats,
    readLogTail,
    renderSidebar,
} from "../registry.ts";
import { formatDuration, formatJobLine, textBlock } from "../format.ts";
import { searchLogs } from "../log-search.ts";
import {
    ensureCompletionPromise,
    markTerminal,
    terminateJobSilently,
} from "../lifecycle.ts";

/** `jobs` 툴을 등록한다. */
export function registerJobsTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "jobs",
        label: "Background Jobs",
        description:
            "Manage background jobs: list, output, kill, attach, search, cleanup, and stats.",
        promptSnippet: "Inspect and manage background jobs",
        promptGuidelines: [
            "list: show all jobs",
            "output: show the log tail for one job",
            "kill: terminate a job",
            "attach: wait for a job to finish and report status; use output for logs",
            "search: regex-search all job output",
            "cleanup: purge terminal jobs",
            "stats: show aggregate metrics",
        ],
        parameters: Type.Object({
            action: StringEnum(
                [
                    "list",
                    "output",
                    "kill",
                    "attach",
                    "search",
                    "cleanup",
                    "stats",
                ] as const,
                { description: "Action to perform" }
            ),
            jobId: Type.Optional(Type.String({ description: "Job ID" })),
            pattern: Type.Optional(
                Type.String({ description: "Regex pattern for search" })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description: "Whether attach should wait for completion (default: true)",
                })
            ),
        }),

        async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
            const p = params as {
                action: "list" | "output" | "kill" | "attach" | "search" | "cleanup" | "stats";
                jobId?: string;
                pattern?: string;
                wait?: boolean;
            };
            switch (p.action) {
                case "list":
                    return listAction(reg);
                case "output":
                    return await outputAction(reg, p.jobId!);
                case "kill":
                    return await killAction(reg, p.jobId!, ctx);
                case "attach":
                    return await attachAction(reg, p.jobId!, p.wait ?? true, signal, onUpdate, ctx);
                case "search":
                    return await searchAction(reg, p.pattern ?? "");
                case "cleanup":
                    return cleanupAction(reg, ctx);
                case "stats":
                    return statsAction(reg);
            }
        },
    });
}

// ─── list: 모든 잡 나열 ──────────────────────────────────────────────────────────────────────

function listAction(reg: BackgroundRegistry): AgentToolResult<undefined> {
    const running = Array.from(reg.jobs.values()).filter(
        (j) => j.status === "running"
    );
    const recent = reg.recentTerminal.slice(-5).reverse();
    const lines = [
        ...running.map((j) => formatJobLine(j)),
        ...recent.map((j) => formatJobLine(j)),
    ];
    return {
        content: [
            textBlock(
                lines.length > 0
                    ? `Background Jobs:\n${lines.join("\n")}`
                    : "No background jobs"
            ),
        ],
        details: undefined,
    };
}

// ─── output: 특정 잡의 출력 꼬리 읽기 ────────────────────────────────────────────────────────

async function outputAction(
    reg: BackgroundRegistry,
    jobId: string
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS).trimEnd();
    const label = job.name ?? job.id;
    return {
        content: [
            textBlock(
                out
                    ? `Output for ${label} (${job.status})\n${out}`
                    : `No output yet for ${label} (${job.status}). Log: ${job.logPath}`
            ),
        ],
        details: undefined,
    };
}

// ─── kill: 특정 잡 종료 ─────────────────────────────────────────────────────────────────────────────

async function killAction(
    reg: BackgroundRegistry,
    jobId: string,
    ctx: UiContext
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status !== "running") {
        throw new Error(`Job is not running: ${job.id}`);
    }
    terminateJobSilently(reg, job);
    renderSidebar(reg, ctx);
    return {
        content: [
            textBlock(
                job.tmux
                    ? `Killed tmux window ${job.tmux.windowId} for ${job.name ?? job.id}`
                    : `Sent SIGTERM to ${job.name ?? job.id} (process group)`
            ),
        ],
        details: undefined,
    };
}

// ─── attach: 완료까지 대기 후 출력 ─────────────────────────────────────────────────────────────────

async function attachAction(
    reg: BackgroundRegistry,
    jobId: string,
    waitForCompletion: boolean,
    signal: AbortSignal | undefined,
    onUpdate: ((u: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined,
    ctx: UiContext
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const skipWait =
        reg.pendingDecisionJobId === job.id && job.status === "running";

    if (job.status === "running" && waitForCompletion && !skipWait) {
        ensureCompletionPromise(job);

        // OS 프로세스가 이미 죽었는지 즉시 확인.
        if (!job.tmux && job.pid > 0 && !processExists(job.pid)) {
            markTerminal(job, "failed");
        }

        onUpdate?.({
            content: [
                textBlock(`Attaching to ${job.name ?? job.id} (${job.status})...`),
            ],
            details: undefined,
        });

        if (signal && !signal.aborted) {
            const abortPromise = new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await Promise.race([job.donePromise, abortPromise]);
        } else {
            await job.donePromise;
        }
    }

    const label = job.name ?? job.id;
    const message = `Attach finished for ${label}. Status: ${job.status}`;
    ctx.ui.notify(message, job.status === "failed" ? "error" : "info");
    return {
        content: [textBlock(`${message}. Use jobs output for logs.`)],
        details: undefined,
    };
}

// ─── search (v0.2 신규) ─────────────────────────────────────────────

const SEARCH_DISPLAY_LIMIT_PER_JOB = 20;

async function searchAction(
    reg: BackgroundRegistry,
    pattern: string
): Promise<AgentToolResult<undefined>> {
    if (!pattern) throw new Error("search action requires a pattern");

    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`);
    }

    const result = await searchLogs({
        jobs: [...Array.from(reg.jobs.values()), ...reg.recentTerminal],
        pattern: re,
        maxHitsPerJob: SEARCH_DISPLAY_LIMIT_PER_JOB,
        maxLineChars: PREVIEW_CHARS.line,
    });

    if (result.totalHits === 0) {
        return {
            content: [textBlock(`No matches for /${pattern}/ in any job log.`)],
            details: undefined,
        };
    }

    const blocks = result.groups.map((group) => {
        const headLabel = group.name ? `${group.name} (${group.jobId})` : group.jobId;
        const body = group.hits
            .map((h) => `  ${h.path}:${h.line}: ${h.text}`)
            .join("\n");
        const more = group.count > group.hits.length
            ? `\n  ... and ${group.count - group.hits.length} more`
            : "";
        return `${headLabel} (${group.count} matches)\n${body}${more}`;
    });

    return {
        content: [
            textBlock(
                `Found ${result.totalHits} matches for /${pattern}/ across ${result.groups.length} job(s):\n\n${blocks.join("\n\n")}`
            ),
        ],
        details: undefined,
    };
}

// ─── cleanup (v0.2 신규) ────────────────────────────────────────────

function cleanupAction(
    reg: BackgroundRegistry,
    ctx: UiContext
): AgentToolResult<undefined> {
    const { purged, bytesReclaimed } = cleanupTerminal(reg);
    renderSidebar(reg, ctx);
    const kb = Math.round(bytesReclaimed / 1024);
    return {
        content: [
            textBlock(
                `Cleaned up ${purged} terminal job(s). Reclaimed ${kb} KiB of disk.`
            ),
        ],
        details: undefined,
    };
}

// ─── stats (v0.2 신규) ──────────────────────────────────────────────

function statsAction(reg: BackgroundRegistry): AgentToolResult<undefined> {
    const s = getStats(reg);
    const lines = [
        `Total started:   ${s.totalStarted}`,
        `Currently running: ${s.running}`,
        `Completed:        ${s.completed}`,
        `Failed:           ${s.failed}`,
        `Killed:           ${s.killed}`,
        `Recent terminal:  ${s.recentTerminal}`,
        `Average duration: ${formatDuration(s.averageDurationMs)}`,
        `Total CPU time:   ${formatDuration(s.totalDurationMs)}`,
    ];
    return {
        content: [textBlock("Background Jobs Stats:\n" + lines.join("\n"))],
        details: undefined,
    };
}
