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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    type Job,
    type TmuxContext,
    type UiContext,
} from "../types.ts";
import {
    getGitRoot,
    killTmuxWindow,
    pollExitSentinel,
    sessionNameForGitRoot,
    spawnDetached,
    spawnTmuxWindow,
} from "../proc.ts";
import { add, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    completeJob,
    ensureCompletionPromise,
    isAutoBackgroundAllowed,
    registerJobCleanup,
    requestJobDecision,
    isBlankCommand,
    requireExistingCwd,
    terminateJobSilently,
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
            "Start a bash command in the background immediately. Output is saved to " +
            "/tmp/pi-bg-<jobId>.log. Optional timeouts trigger the bg-timeout flow.",
        promptSnippet: "Start long-running commands directly in the background",
        promptGuidelines: [
            "Use this when a command should definitely start in the background.",
            "Give the job a name when it will be easier to track in jobs list.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "Command to run" }),
            name: Type.Optional(
                Type.String({
                    description: "Optional label shown in jobs list.",
                })
            ),
            timeout: Type.Optional(
                Type.Number({
                    description:
                        "Optional timeout in seconds. When exceeded, the job enters the bg-timeout flow.",
                })
            ),
            notify: Type.Optional(
                Type.Boolean({
                    description: "Notify on completion (default: true)",
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

            if (reg.tmuxAvailable && getGitRoot(ctx2.cwd)) {
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
                            `Command running in background with ID: ${tmuxJob.id}.${p.name ? ` Name: ${p.name}.` : ""} Output is being written to: ${tmuxJob.logPath}`
                        ),
                    ],
                    details: undefined,
                };
            }
            // git repo가 없으면 direct spawn으로 폴백.

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
            ensureCompletionPromise(job);
            add(reg, job);

            const cancelStall = watchStalls({
                jobId: id,
                command: p.command,
                logPath,
                pi,
                onOversize: () => terminateJobSilently(reg, job),
            });

            const cancelTimeout = timeoutMs !== undefined
                ? armTimeoutForSpawnedJob({ reg, pi, ctx: ctx2, job, timeoutMs })
                : () => {};
            registerJobCleanup(reg, id, () => {
                cancelTimeout();
                cancelStall();
            });

            spawned.proc.on("close", (code) => {
                cancelTimeout();
                cancelStall();
                completeJob({ job, code, reg, pi, ctx: ctx2, shouldNotify });
            });
            spawned.proc.on("error", () => {
                cancelTimeout();
                cancelStall();
                completeJob({ job, code: 1, reg, pi, ctx: ctx2, shouldNotify });
            });

            renderSidebar(reg, ctx2);
            return {
                content: [
                    textBlock(
                        `Command running in background with ID: ${id}.${p.name ? ` Name: ${p.name}.` : ""} Output is being written to: ${logPath}`
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
    const gitRoot = getGitRoot(args.cwd)!;
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
    ensureCompletionPromise(job);
    add(args.reg, job);

    const cancelStall = watchStalls({
        jobId: id,
        command: args.command,
        logPath,
        pi: args.pi,
        onOversize: () => terminateJobSilently(args.reg, job),
    });
    const cancelTimeout = args.timeoutMs !== undefined
        ? armTimeoutForSpawnedJob({
              reg: args.reg,
              pi: args.pi,
              ctx: args.ctx,
              job,
              timeoutMs: args.timeoutMs,
          })
        : () => {};
    const sentinel = new AbortController();
    registerJobCleanup(args.reg, id, () => {
        sentinel.abort();
        cancelTimeout();
        cancelStall();
    });

    // sentinel 파일 폴링 — 6h 안전 타임아웃 포함.
    pollExitSentinel({ file: tmuxCtx.exitCodeFile, signal: sentinel.signal }).then((code) => {
        killTmuxWindow(tmuxCtx.windowId);
        completeJob({
            job,
            code: code ?? undefined,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
            shouldNotify: args.shouldNotify,
        });
    });

    return job;
}

function armTimeoutForSpawnedJob(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: BashBgCtx;
    job: Job;
    timeoutMs: number;
}): () => void {
    const timer = setTimeout(() => {
        const live = args.reg.jobs.get(args.job.id);
        if (live !== args.job || args.job.status !== "running") return;
        if (args.reg.nonInteractive) return;
        if (!isAutoBackgroundAllowed(args.job.command)) {
            terminateJobSilently(args.reg, args.job);
            renderSidebar(args.reg, args.ctx);
            return;
        }
        // bg-timeout 흐름: 에이전트에게 결정 요청.
        const location =
            args.job.tmux
                ? ({ kind: "tmux", windowId: args.job.tmux.windowId } as const)
                : ({ kind: "pid", pid: args.job.pid } as const);
        requestJobDecision({
            reg: args.reg,
            pi: args.pi,
            job: args.job,
            timeoutMs: args.timeoutMs,
            location,
        });
    }, args.timeoutMs);
    timer.unref();
    return () => clearTimeout(timer);
}
