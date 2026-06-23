/**
 * `bash_bg` 툴 — 처음부터 백그라운드에서 명령을 실행한다.
 *
 * `bash` 툴의 오버라이드와 달리 race/타임아웃/quick-completion 윈도우가
 * 없다. 자식은 백그라운드에서 평생 실행되며 완료 시 notifyFinished가
 * 호출된다.
 *
 * v0.2 신규 기능:
 *   - `--name <name>`: 잡에 사람이 읽을 수 있는 라벨을 부여한다.
 *   - `timeout` (초): 선택적 타임아웃. 초과 시 bash 툴과 동일한
 *     `bg-timeout` 흐름으로 전환된다.
 */

import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS,
    EVENT,
    QUICK_COMPLETION_MS as _Q,
    type Job,
    type TmuxContext,
    type UiContext,
} from "../types.ts";
import {
    getGitRoot,
    killProcessTree,
    killTmuxWindow,
    readExitSentinel,
    sessionNameForGitRoot,
    spawnDetached,
    spawnTmuxWindow,
} from "../proc.ts";
import { add, findJob, forget, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    buildTimeoutNotice,
    createCompletionPromise,
    isAutoBackgroundAllowed,
    isBlankCommand,
    markTerminal,
    notifyFinished,
    requireExistingCwd,
    statusFromExit,
    watchStalls,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";

type BashBgParams = {
    command: string;
    name?: string;
    timeout?: number;
    notify?: boolean;
};

type BashBgCtx = UiContext & { cwd: string };

/** `bash_bg` 툴을 등록한다. */
export function registerBashBgTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Bash 명령을 백그라운드에서 즉시 실행. 출력은 /tmp/pi-bg-<jobId>.log. " +
            "선택적 timeout(초)이 지나면 자동 bg-timeout 흐름으로 전환된다.",
        promptSnippet: "장기 실행 명령을 백그라운드로 시작",
        promptGuidelines: [
            "처음부터 백그라운드 실행이 확실할 때 사용.",
            "이름을 부여하면 jobs list에서 추적이 쉬워진다.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "실행할 명령" }),
            name: Type.Optional(
                Type.String({
                    description: "선택적 라벨. jobs list에 표시된다.",
                })
            ),
            timeout: Type.Optional(
                Type.Number({
                    description:
                        "선택적 타임아웃(초). 초과 시 자동 bg-timeout 흐름으로 전환된다.",
                })
            ),
            notify: Type.Optional(
                Type.Boolean({
                    description: "완료 시 알림 (기본: true)",
                })
            ),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as BashBgParams;
            const ctx2 = ctx as BashBgCtx;
            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(ctx2.cwd);

            const shouldNotify = p.notify !== false;
            const timeoutMs = p.timeout ? p.timeout * 1_000 : undefined;

            if (reg.tmuxAvailable) {
                const tmuxJob = spawnViaTmux({
                    command: p.command,
                    cwd: ctx2.cwd,
                    name: p.name,
                    reg,
                    pi,
                    ctx: ctx2,
                    shouldNotify,
                    timeoutMs,
                    toolCallId,
                });
                renderSidebar(reg, ctx2);
                return {
                    content: [
                        textBlock(
                            `Started background job ${tmuxJob.id}${p.name ? ` (${p.name})` : ""}\nCommand: ${p.command}\nOutput: ${tmuxJob.logPath}`
                        ),
                    ],
                    details: undefined,
                };
            }

            const id = nextJobId(reg);
            const logPath = logPathFor(id);
            const spawned = spawnDetached(p.command, ctx2.cwd, logPath);

            const job: Job = {
                id,
                name: p.name,
                command: p.command,
                pid: spawned.proc.pid!,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc: spawned.proc,
                toolCallId,
                isBackgrounded: true,
            };
            createCompletionPromise(job);
            add(reg, job);

            const cancelStall = watchStalls({
                jobId: id,
                command: p.command,
                logPath,
                pi,
                onOversize: () => {
                    if (spawned.proc.pid) killProcessTree(spawned.proc.pid, "SIGTERM");
                    job.outputConsumed = true;
                    markTerminal(job, "killed");
                },
            });

            spawned.proc.on("close", (code) => {
                cancelStall();
                if (job.status !== "running") return;
                markTerminal(job, statusFromExit(code), code ?? undefined);
                if (shouldNotify) {
                    const finished = findJob(reg, id);
                    if (finished) {
                        notifyFinished({ job: finished, reg, pi, ctx: ctx2 });
                        forget(reg, finished);
                        renderSidebar(reg, ctx2);
                    }
                }
            });
            spawned.proc.on("error", () => {
                cancelStall();
                if (job.status !== "running") return;
                markTerminal(job, "failed");
                if (shouldNotify) {
                    const finished = findJob(reg, id);
                    if (finished) {
                        notifyFinished({ job: finished, reg, pi, ctx: ctx2 });
                        forget(reg, finished);
                        renderSidebar(reg, ctx2);
                    }
                }
            });

            // timeout이 있으면 timeout-tick 별도 시작.
            if (timeoutMs !== undefined) {
                armTimeoutForSpawnedJob({
                    reg,
                    pi,
                    ctx: ctx2,
                    job,
                    timeoutMs,
                    shouldNotify,
                });
            }

            renderSidebar(reg, ctx2);
            return {
                content: [
                    textBlock(
                        `Started background job ${id}${p.name ? ` (${p.name})` : ""}\nCommand: ${p.command}\nPID: ${spawned.proc.pid}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        },
    });
}

// ─── tmux 백엔드 헬퍼 ───────────────────────────────────────────────

function spawnViaTmux(args: {
    command: string;
    cwd: string;
    name: string | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: BashBgCtx;
    shouldNotify: boolean;
    timeoutMs: number | undefined;
    toolCallId: string;
}): Job {
    const gitRoot = getGitRoot(args.cwd);
    if (!gitRoot) {
        throw new Error(
            "tmux backend requires a git repository. " +
                "Falling back to direct process management."
        );
    }
    const session = sessionNameForGitRoot(gitRoot);
    const tmuxSpawn = spawnTmuxWindow({
        command: args.command,
        cwd: args.cwd,
        session,
    });

    const id = `tmux-${process.pid}-${++args.reg.counter}`;
    const logPath = tmuxSpawn.outputFile;
    const tmuxCtx: TmuxContext = {
        session,
        windowId: tmuxSpawn.windowId,
        exitCodeFile: tmuxSpawn.exitCodeFile,
        outputFile: tmuxSpawn.outputFile,
        gitRoot,
    };

    const job: Job = {
        id,
        name: args.name,
        command: args.command,
        pid: -1,
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: true,
        tmux: tmuxCtx,
    };
    createCompletionPromise(job);
    add(args.reg, job);

    const cancelStall = args.pi && args.shouldNotify
        ? watchStalls({
              jobId: id,
              command: args.command,
              logPath,
              pi: args.pi,
              onOversize: () => killTmuxWindow(tmuxCtx.windowId),
          })
        : () => {};

    // 6시간 안전 타임아웃 — sentinel 파일이 영원히 안 쓰이는 경우 leak 방지.
    const MAX_POLLS = 43_200; // 6h ÷ 500ms
    let pollCount = 0;
    const poll = setInterval(() => {
        if (++pollCount > MAX_POLLS) {
            clearInterval(poll);
            cancelStall();
            if (job.status === "running") {
                markTerminal(job, "failed");
            }
            return;
        }
        const code = readExitSentinel(tmuxCtx.exitCodeFile);
        if (code === undefined) return;
        clearInterval(poll);
        cancelStall();
        if (job.status !== "running") return;
        markTerminal(job, statusFromExit(code), code);
        killTmuxWindow(tmuxCtx.windowId);
        if (args.shouldNotify) {
            const finished = findJob(args.reg, id);
            if (finished) {
                notifyFinished({
                    job: finished,
                    reg: args.reg,
                    pi: args.pi,
                    ctx: args.ctx,
                });
                forget(args.reg, finished);
                renderSidebar(args.reg, args.ctx);
            }
        }
    }, 500);
    poll.unref();

    return job;
}

function armTimeoutForSpawnedJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: BashBgCtx;
    job: Job;
    timeoutMs: number;
    shouldNotify: boolean;
}): void {
    const timer = setTimeout(() => {
        if (args.reg.nonInteractive) return;
        if (!isAutoBackgroundAllowed(args.job.command)) {
            terminateJobRef(args.job);
            return;
        }
        // bg-timeout 흐름: 에이전트에게 결정 요청.
        const location =
            args.job.tmux
                ? ({ kind: "tmux", windowId: args.job.tmux.windowId } as const)
                : ({ kind: "pid", pid: args.job.pid } as const);
        args.reg.pendingDecisionJobId = args.job.id;
        args.pi.sendMessage(
            {
                customType: EVENT.timeout,
                content: buildTimeoutNotice({
                    jobId: args.job.id,
                    command: args.job.command,
                    logPath: args.job.logPath,
                    timeoutMs: args.timeoutMs,
                    location,
                }).content,
                display: true,
                details: {
                    jobId: args.job.id,
                    logPath: args.job.logPath,
                    command: args.job.command,
                },
            },
            { deliverAs: "followUp", triggerTurn: true }
        );
    }, args.timeoutMs);
    timer.unref();
}

function terminateJobRef(job: Job): void {
    if (job.tmux) {
        killTmuxWindow(job.tmux.windowId);
        return;
    }
    if (job.pid > 0) killProcessTree(job.pid, "SIGTERM");
}

void mkdirSync;
void openSync;
void closeSync;
void dirname;
void DEFAULT_TIMEOUT_MS;
void _Q;
