/**
 * `agent_bg` 툴 — 별도 `pi -p` 프로세스를 백그라운드에서 실행한다.
 *
 * 현재 세션의 첫 user prompt와 마지막 assistant 메시지를 종합한
 * 연속성 프롬프트를 구성하고, 동일한 모델(provider/id)로 detached
 * `pi -p` 프로세스를 spawn한다. 출력은 /tmp/pi-bg-<jobId>.log에 기록되며
 * 완료 시 notifyFinished가 호출된다.
 */

import { spawn } from "node:child_process";
import {
    createWriteStream,
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    isBlankCommand,
    requireExistingCwd as requireExistingCwdHelper,
} from "../lifecycle.ts";
import {
    killProcessTree,
} from "../proc.ts";
import {
    findJob,
    forget,
    nextJobId,
    logPathFor,
    renderSidebar,
} from "../registry.ts";
import { markKilledSilently, markTerminal, notifyFinished, statusFromExit, watchStalls } from "../lifecycle.ts";
import type { Job } from "../types.ts";

type AgentBgParams = {
    prompt: string;
    cwd?: string;
};

function textBlock(s: string) {
    return { type: "text" as const, text: s };
}

// ─── 컨텍스트 추출 ─────────────────────────────────────────────────

interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

/** 메시지 엔트리 식별. pi의 SessionMessageEntry와 동일하지만 로컬 구조 타입. */
function isMessageEntry(
    entry: SessionEntry
): entry is SessionEntry & { message: ContentMessage } {
    return entry.type === "message" && "message" in entry;
}

/** 메시지 콘텐츠에서 텍스트 추출. 알 수 없는 블록은 무시. */
function extractText(
    content: string | { type: string; text?: string }[]
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b): b is { type: string; text: string } =>
                typeof b === "object" &&
                b !== null &&
                b.type === "text" &&
                typeof b.text === "string"
        )
        .map((b) => b.text)
        .join("\n");
}

/** 세션에서 마지막 assistant 메시지 텍스트. 없으면 "". */
function lastAssistantText(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (isMessageEntry(e) && e.message.role === "assistant") {
            return extractText(e.message.content).slice(-2_000);
        }
    }
    return "";
}

/** 세션의 첫 user prompt. 없으면 "". */
function firstUserPrompt(entries: SessionEntry[]): string {
    for (const e of entries) {
        if (isMessageEntry(e) && e.message.role === "user") {
            return extractText(e.message.content).slice(0, 2_000);
        }
    }
    return "";
}

// ─── 툴 등록 ─────────────────────────────────────────────────────────

/** `agent_bg` 툴을 등록한다. */
export function registerAgentBgTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description:
            "별도 pi -p 프로세스를 백그라운드에서 실행. 현재 세션의 " +
            "user prompt + 마지막 assistant 메시지를 종합한 연속성 프롬프트 전달.",
        promptSnippet: "백그라운드 pi -p 프로세스로 작업 위임",
        promptGuidelines: [
            "현재 세션과 독립적으로 실행 가능한 작업에 사용.",
            "연속성 프롬프트에 원본 작업과 마지막 위치가 포함됨.",
            "완료 시 notifyFinished로 통지.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "백그라운드 에이전트에 전달할 작업" }),
            cwd: Type.Optional(
                Type.String({ description: "작업 디렉터리 (기본: 현재)" })
            ),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as AgentBgParams;
            if (isBlankCommand(p.prompt)) throw new Error("Prompt is empty.");
            const cwd = p.cwd ?? ctx.cwd;
            requireExistingCwdHelper(cwd);

            const id = nextJobId(reg);
            const logPath = logPathFor(id);
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            // 연속성 프롬프트 구성.
            const entries = ctx.sessionManager.getEntries();
            const summary = lastAssistantText(entries);
            const originalPrompt = firstUserPrompt(entries);

            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "",
                "## Original task",
                p.prompt,
                ...(originalPrompt
                    ? ["", "## Previous user context", originalPrompt]
                    : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "",
                "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${id}.md`;
            writeFileSync(promptFile, promptContent);

            const model = ctx.model;
            const modelArg = model ? `${model.provider}/${model.id}` : undefined;
            const spawnArgs = [
                "-p",
                "--mode",
                "text",
                ...(modelArg ? ["--model", modelArg] : []),
                `@${promptFile}`,
            ];

            const proc = spawn("pi", spawnArgs, {
                cwd,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!proc.pid) {
                try {
                    unlinkSync(promptFile);
                } catch {
                    /* ignore */
                }
                throw new Error("Failed to spawn background agent process");
            }

            const logStream = createWriteStream(logPath, { flags: "w" });
            proc.stdout?.pipe(logStream, { end: false });
            proc.stderr?.pipe(logStream, { end: false });

            const job: Job = {
                id,
                command: `pi -p (background agent)`,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: true,
            };
            addJob(reg, job);

            const cancelStall = watchStalls({
                jobId: id,
                command: job.command,
                logPath,
                pi,
                onOversize: () => {
                    if (proc.pid) killProcessTree(proc.pid, "SIGTERM");
                    markKilledSilently(job);
                },
            });

            const cleanupFiles = [promptFile];
            const finalize = (code: number | null) => {
                cancelStall();
                logStream.end();
                if (job.status !== "running") return;
                markTerminal(job, statusFromExit(code), code ?? undefined);
                const finished = findJob(reg, id);
                if (finished) {
                    notifyFinished({ job: finished, reg, pi, ctx });
                    forget(reg, finished);
                    renderSidebar(reg, ctx);
                }
                for (const f of cleanupFiles) {
                    try {
                        unlinkSync(f);
                    } catch {
                        /* 이미 사라짐 */
                    }
                }
            };

            proc.on("close", finalize);
            proc.on("error", () => finalize(1));

            renderSidebar(reg, ctx);

            return {
                content: [
                    textBlock(
                        `Started background agent ${id}\n` +
                            `Prompt: ${p.prompt.slice(0, 100)}${p.prompt.length > 100 ? "…" : ""}\n` +
                            `PID: ${proc.pid}\n` +
                            `Output: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        },
    });
}

function addJob(reg: BackgroundRegistry, job: Job): void {
    reg.jobs.set(job.id, job);
    reg.totalStarted++;
}

void addJob;
