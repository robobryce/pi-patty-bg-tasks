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

import { openSync, readSync, closeSync, unlinkSync, readFileSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    OUTPUT_PREVIEW_CHARS,
    PREVIEW_CHARS,
    type Job,
    type UiContext,
} from "../types.ts";
import {
    processExists,
    killProcessTree as _kp,
    killTmuxWindow,
} from "../proc.ts";
import {
    cleanupTerminal,
    findJob,
    forget,
    getStats,
    readLogTail,
    renderSidebar,
} from "../registry.ts";
import { formatDuration, formatJobLine, textBlock, truncateTail } from "../format.ts";
import {
    createCompletionPromise,
    isSignalExit,
    markKilledSilently,
    markTerminal,
    terminateJob,
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
            "백그라운드 잡 관리. list / output / kill / attach / search / cleanup / stats.",
        promptSnippet: "백그라운드 잡 조회·관리",
        promptGuidelines: [
            "list: 모든 잡 보기",
            "output: 특정 잡의 로그 꼬리",
            "kill: 잡 종료",
            "attach: 잡 완료까지 대기",
            "search: 정규식으로 모든 출력 검색",
            "cleanup: 종료된 잡 일괄 정리",
            "stats: 집계 메트릭",
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
                { description: "수행할 액션" }
            ),
            jobId: Type.Optional(Type.String({ description: "잡 ID" })),
            pattern: Type.Optional(
                Type.String({ description: "search 정규식" })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description: "attach 시 완료 대기 여부 (기본 true)",
                })
            ),
        }),

        async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
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
                    return await attachAction(reg, p.jobId!, p.wait ?? true, signal, onUpdate);
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
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    return {
        content: [
            textBlock(
                `Output for ${job.name ?? job.id} (${job.status})\nLog: ${job.logPath}\n\n${out}`
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
    terminateJob(job);
    markKilledSilently(job);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
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
    onUpdate: ((u: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined
): Promise<AgentToolResult<undefined>> {
    const job = findJob(reg, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const skipWait =
        reg.pendingDecisionJobId === job.id && job.status === "running";

    if (job.status === "running" && waitForCompletion && !skipWait) {
        createCompletionPromise(job);

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

    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    job.outputConsumed = true;
    return {
        content: [
            textBlock(
                `Attach finished for ${job.name ?? job.id}. Status: ${job.status}\nLog: ${job.logPath}\n\n${out}`
            ),
        ],
        details: undefined,
    };
}

// ─── search (v0.2 신규) ─────────────────────────────────────────────

interface SearchHit {
    jobId: string;
    name?: string;
    path: string;
    line: number;
    text: string;
}

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

    const hits: SearchHit[] = [];
    const all = [...Array.from(reg.jobs.values()), ...reg.recentTerminal];
    for (const job of all) {
        if (job.tmux) continue; // tmux 잡은 파일에 안 쓰여짐 — 스킵.
        const content = readAll(job.logPath);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                hits.push({
                    jobId: job.id,
                    name: job.name,
                    path: job.logPath,
                    line: i + 1,
                    text: lines[i],
                });
            }
        }
    }

    if (hits.length === 0) {
        return {
            content: [textBlock(`No matches for /${pattern}/ in any job log.`)],
            details: undefined,
        };
    }

    const grouped = groupHitsByJob(hits);
    const blocks = Object.entries(grouped).map(([jobId, jobHits]) => {
        const head = jobHits[0];
        const headLabel = head?.name ? `${head.name} (${jobId})` : jobId;
        const body = jobHits
            .slice(0, 20)
            .map((h) => `  ${h.path}:${h.line}: ${h.text}`)
            .join("\n");
        const more = jobHits.length > 20 ? `\n  ... and ${jobHits.length - 20} more` : "";
        return `${headLabel} (${jobHits.length} matches)\n${body}${more}`;
    });

    return {
        content: [
            textBlock(
                `Found ${hits.length} matches for /${pattern}/ across ${Object.keys(grouped).length} job(s):\n\n${blocks.join("\n\n")}`
            ),
        ],
        details: undefined,
    };
}

function readAll(path: string): string {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return "";
    }
}

function groupHitsByJob(hits: SearchHit[]): Record<string, SearchHit[]> {
    const out: Record<string, SearchHit[]> = {};
    for (const h of hits) {
        (out[h.jobId] ??= []).push(h);
    }
    return out;
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

void openSync;
void readSync;
void closeSync;
void unlinkSync;
void PREVIEW_CHARS;
void isSignalExit;
void _kp;
void killTmuxWindow;
void truncateTail;
void formatDuration;
void forget;
