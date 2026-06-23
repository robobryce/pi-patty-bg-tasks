/**
 * `bash` 툴 오버라이드.
 *
 * 표준 bash 툴을 확장해 다음 동작을 추가한다:
 *   - 15초 후 자동 백그라운딩 (job_decide 응답 필요)
 *   - 사용자가 Ctrl+Shift+B를 누르면 즉시 백그라운딩
 *   - 2초 안에 완료되면 빠른 종료 경로 (백그라운딩 절차 생략)
 *   - tmux 사용 가능 시 tmux 윈도우로 실행 (race 윈도우 제거)
 */

import { mkdirSync, openSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { randomUUID } from "node:crypto";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS,
    EVENT,
    FOREGROUND_TAIL_BYTES as _F,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    type ForegroundSlot,
    type Job,
    type TmuxContext,
    type UiContext,
} from "../types.ts";
import {
    capturePane,
    clearTimer,
    getGitRoot,
    killProcessTree,
    killTmuxWindow,
    pollExitSentinel,
    sessionNameForGitRoot,
    spawnDetached,
    spawnTmuxWindow,
    tmuxRunDir,
} from "../proc.ts";
import { add, findJob, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    buildTimeoutNotice,
    completeJob,
    createCompletionPromise,
    detectBlockedSleep,
    isAutoBackgroundAllowed,
    isBlankCommand,
    isSignalExit,
    markKilledSilently,
    markTerminal,
    requireExistingCwd,
    scheduleTimeout,
    watchProgress,
    watchStalls,
} from "../lifecycle.ts";
import { textBlock, truncateTail } from "../format.ts";

/** UI 컨텍스트 + cwd만으로 충분한 축소 인터페이스. */
type BashCtx = UiContext & { cwd: string };



/** `bash` 툴을 등록한다. */
export function registerBashTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    originalBash: ReturnType<typeof createBashTool>
): void {
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description:
            "Bash 명령 실행. 15초 후 자동 백그라운딩되며, " +
            "Ctrl+Shift+B로 수동 백그라운딩 가능. 백그라운드 잡의 출력은 " +
            "/tmp/pi-bg-<jobId>.log에 저장된다.",
        promptSnippet: "셸 명령 실행 (Ctrl+Shift+B로 백그라운딩 가능)",
        promptGuidelines: [
            "장시간 실행이 예상되면 처음부터 bash_bg 사용.",
            "상태 확인은 jobs 툴의 action='list'.",
            "출력은 jobs 툴의 action='output'.",
        ],

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const command = (params as { command: string }).command;
            const bashCtx = ctx as BashCtx;

            // 입력 검증.
            if (isBlankCommand(command)) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);

            const sleepMatch = detectBlockedSleep(command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash_bg for long waits. ` +
                        "For pacing < 2s, sleep is fine."
                );
            }

            // tmux 백엔드를 우선 시도한다.
            if (reg.tmuxAvailable) {
                try {
                    return await runViaTmux(
                        toolCallId,
                        command,
                        params as { timeout?: number },
                        signal,
                        onUpdate,
                        bashCtx,
                        reg,
                        pi
                    );
                } catch {
                    // tmux 백엔드 실패 시 직접 spawn으로 폴백.
                }
            }

            return await runDirect(
                toolCallId,
                command,
                params as { timeout?: number },
                signal,
                onUpdate,
                bashCtx,
                reg,
                pi
            );
        },
    });
}

// ─── 직접 spawn 백엔드 ──────────────────────────────────────────────

async function runDirect(
    toolCallId: string,
    command: string,
    params: { timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: BashCtx,
    reg: BackgroundRegistry,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const id = nextJobId(reg);
    const logPath = logPathFor(id);
    const spawned = spawnDetached(command, ctx.cwd, logPath);

    // foreground 슬롯에 등록 — Ctrl+Shift+B 핸들러가 여기서 잡을 찾는다.
    let pauseResolve: (() => void) | null = null;
    const pausePromise = new Promise<void>((resolve) => {
        pauseResolve = resolve;
    });
    const requestPause = () => pauseResolve?.();

    const slot: ForegroundSlot = {
        toolCallId,
        proc: spawned.proc,
        command,
        logPath,
        requestPause,
    };
    reg.foreground.set(toolCallId, slot);
    reg.activeToolCallId = toolCallId;

    // 임시 잡 엔트리 (foreground 단계에서 jobs 툴에 표시됨).
    const placeholder: Job = {
        id,
        command,
        pid: spawned.proc.pid!,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc: spawned.proc,
        toolCallId,
        isBackgrounded: false,
    };
    add(reg, placeholder);

    if (signal) {
        signal.addEventListener("abort", () => {
            if (spawned.proc.pid) killProcessTree(spawned.proc.pid, "SIGTERM");
        });
    }

    const timeoutMs = params.timeout ? params.timeout * 1_000 : undefined;
    const timer = scheduleTimeout({
        requestPause,
        command,
        reg,
        toolCallId,
        explicitMs: timeoutMs,
        isAutoBackgroundAllowed,
    });

    const hintTimer = nodeSetTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+Shift+B to background", "info");
    }, QUICK_COMPLETION_MS);
    hintTimer.unref();

    let progress: { stop: () => void } | undefined;
    const clearAllTimers = () => {
        progress?.stop();
        clearTimer(timer);
        clearTimer(hintTimer);
    };

    try {
        // 2초 빠른 종료 윈도우.
        const quickResult = await Promise.race<
            { code: number | null; signal: boolean } | null
        >([
            spawned.exit.then((c) => ({
                code: c,
                signal: isSignalExit(c),
            })),
            new Promise<null>((resolve) => {
                const t = nodeSetTimeout(resolve, QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            // 빠르게 완료됨 — 즉시 반환.
            reg.jobs.delete(id);
            return {
                content: [textBlock(await readLogTailAsync(logPath))],
                details: undefined,
            };
        }

        // 여전히 실행 중 — 진행률 폴링 시작.
        progress = watchProgress(logPath, (text) => {
            onUpdate?.({
                content: [{ type: "text", text }],
                details: undefined,
            });
        });

        // 완료 vs 백그라운딩 경합.
        const race = await Promise.race<
            | { kind: "completed"; code: number | null; signal: boolean }
            | { kind: "backgrounded" }
        >([
            spawned.exit.then((c) => ({
                kind: "completed" as const,
                code: c,
                signal: isSignalExit(c),
            })),
            pausePromise.then(() => ({ kind: "backgrounded" as const })),
        ]);

        if (race.kind === "backgrounded") {
            // 백그라운딩으로 전환.
            clearAllTimers();
            reg.foreground.delete(toolCallId);
            promoteToBackground({
                reg,
                pi,
                ctx,
                placeholder,
                proc: spawned.proc,
                toolCallId,
                command,
                logPath,
                timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });
            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${id}\nCommand: ${command}\nPID: ${spawned.proc.pid}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        // 정상 완료.
        clearAllTimers();
        reg.foreground.delete(toolCallId);
        if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
        reg.jobs.delete(id);

        const output = await readLogTailAsync(logPath);
        if (
            race.code !== 0 &&
            race.code !== null &&
            !race.signal
        ) {
            throw new Error(output || `Command exited with code ${race.code}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        clearAllTimers();
    }
}

// ─── tmux 백엔드 ────────────────────────────────────────────────────

async function runViaTmux(
    toolCallId: string,
    command: string,
    params: { timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: BashCtx,
    reg: BackgroundRegistry,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const gitRoot = gitRootOrThrow(ctx.cwd);
    const session = sessionNameForGitRoot(gitRoot);
    const tmuxSpawn = spawnTmuxWindow({
        command,
        cwd: ctx.cwd,
        session,
    });

    const id = `tmux-${process.pid}-${++reg.counter}`;
    const logPath = tmuxSpawn.outputFile;
    const tmuxCtx: TmuxContext = {
        session,
        windowId: tmuxSpawn.windowId,
        exitCodeFile: tmuxSpawn.exitCodeFile,
        outputFile: tmuxSpawn.outputFile,
        gitRoot,
    };

    let pauseResolve: (() => void) | null = null;
    const pausePromise = new Promise<void>((resolve) => {
        pauseResolve = resolve;
    });
    const requestPause = () => pauseResolve?.();

    const job: Job = {
        id,
        command,
        pid: -1,
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: false,
        tmux: tmuxCtx,
    };
    createCompletionPromise(job);
    add(reg, job);

    reg.foreground.set(toolCallId, {
        toolCallId,
        proc: { pid: -1 } as never,
        command,
        logPath,
        requestPause,
    });
    reg.activeToolCallId = toolCallId;

    if (signal) {
        signal.addEventListener("abort", () => killTmuxWindow(tmuxCtx.windowId));
    }

    const timeoutMs = params.timeout ? params.timeout * 1_000 : DEFAULT_TIMEOUT_MS;
    const timer = scheduleTimeout({
        requestPause,
        command,
        reg,
        toolCallId,
        explicitMs: timeoutMs,
        isAutoBackgroundAllowed,
    });

    const hintTimer = nodeSetTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+Shift+B to background", "info");
    }, QUICK_COMPLETION_MS);
    hintTimer.unref();

    // 종료 sentinel 폴링.
    const completionPromise = pollExitSentinel({ file: tmuxCtx.exitCodeFile, intervalMs: 200 });

    let progress: { stop: () => void } | undefined;
    const clearAllTimers = () => {
        progress?.stop();
        clearTimer(timer);
        clearTimer(hintTimer);
    };

    try {
        const quickResult = await Promise.race<number | null>([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = nodeSetTimeout(resolve, QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            reg.jobs.delete(id);
            const output = captureFromTmux(tmuxCtx);
            killTmuxWindow(tmuxCtx.windowId);
            if (quickResult !== 0) {
                throw new Error(output || `Command exited with code ${quickResult}`);
            }
            return { content: [textBlock(output || "(no output)")], details: undefined };
        }

        progress = watchProgress(logPath, (text) => {
            onUpdate?.({
                content: [{ type: "text", text }],
                details: undefined,
            });
        });

        const race = await Promise.race<
            { kind: "completed"; code: number | null } | { kind: "backgrounded" }
        >([
            completionPromise.then((c) => ({ kind: "completed" as const, code: c })),
            pausePromise.then(() => ({ kind: "backgrounded" as const })),
        ]);

        if (race.kind === "backgrounded") {
            clearAllTimers();
            reg.foreground.delete(toolCallId);
            job.isBackgrounded = true;
            reg.activeToolCallId = null;
            // 백그라운드 폴러 + 정체 감시 시작.
            const cancelStall = watchStalls({
                jobId: id,
                command,
                logPath,
                pi,
                onOversize: () => killTmuxWindow(tmuxCtx.windowId),
            });

            // sentinel 폴링 → 완료 시 정리.
            pollExitSentinel({ file: tmuxCtx.exitCodeFile }).then((code) => {
                cancelStall();
                killTmuxWindow(tmuxCtx.windowId);
                completeJob({ job, code, reg, pi, ctx });
            });

            reg.pendingDecisionJobId = id;

            pi.sendMessage(
                {
                    customType: EVENT.timeout,
                    content: buildTimeoutNotice({
                        jobId: id,
                        command,
                        logPath,
                        timeoutMs,
                        location: { kind: "tmux", windowId: tmuxCtx.windowId },
                    }).content,
                    display: true,
                    details: { jobId: id, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );

            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${id}\nCommand: ${command}\nTmux window: ${tmuxCtx.windowId}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        clearAllTimers();
        reg.foreground.delete(toolCallId);
        if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
        reg.jobs.delete(id);

        const output = captureFromTmux(tmuxCtx);
        killTmuxWindow(tmuxCtx.windowId);
        if (race.code !== 0 && race.code !== null) {
            throw new Error(output || `Command exited with code ${race.code}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        clearAllTimers();
    }
}

// ─── 백그라운드 승격 헬퍼 ───────────────────────────────────────────

function promoteToBackground(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    placeholder: Job;
    proc: import("node:child_process").ChildProcess;
    toolCallId: string;
    command: string;
    logPath: string;
    timeoutMs: number;
}): void {
    const cancelStall = watchStalls({
        jobId: args.placeholder.id,
        command: args.command,
        logPath: args.logPath,
        pi: args.pi,
        onOversize: () => {
            if (args.proc.pid) killProcessTree(args.proc.pid, "SIGTERM");
            markKilledSilently(args.placeholder);
        },
    });

    args.proc.on("close", (code) => {
        cancelStall();
        if (args.reg.pendingDecisionJobId === args.placeholder.id) {
            args.reg.pendingDecisionJobId = undefined;
        }
        completeJob({
            job: args.placeholder,
            code,
            reg: args.reg,
            pi: args.pi,
            ctx: args.ctx,
        });
    });

    args.placeholder.isBackgrounded = true;
    args.reg.activeToolCallId = null;
    args.reg.pendingDecisionJobId = args.placeholder.id;

    args.ctx.ui.notify(`Process backgrounded as ${args.placeholder.id}`, "info");
    renderSidebar(args.reg, args.ctx);

    args.pi.sendMessage(
        {
            customType: EVENT.timeout,
            content: buildTimeoutNotice({
                jobId: args.placeholder.id,
                command: args.command,
                logPath: args.logPath,
                timeoutMs: args.timeoutMs,
                location: { kind: "pid", pid: args.placeholder.pid },
            }).content,
            display: true,
            details: {
                jobId: args.placeholder.id,
                logPath: args.logPath,
                command: args.command,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

// ─── 보조 ────────────────────────────────────────────────────────────

function gitRootOrThrow(cwd: string): string {
    const root = getGitRoot(cwd);
    if (!root) {
        throw new Error(
            "tmux backend requires a git repository. " +
                "Falling back to direct process management."
        );
    }
    return root;
}

async function readLogTailAsync(logPath: string): Promise<string> {
    try {
        const content = await readFile(logPath, "utf-8");
        return truncateTail(content, OUTPUT_PREVIEW_CHARS);
    } catch {
        return "(no output)";
    }
}

function captureFromTmux(ctx: TmuxContext): string {
    return capturePane(ctx.windowId, 2_000, ctx.outputFile);
}



// registerBashTool만 공개 진입점. 다른 export는 의도된 보조.
void randomUUID;
void StringEnum;
void Type;
void mkdirSync;
void openSync;
void closeSync;
void dirname;
void tmuxRunDir;
void _F;
