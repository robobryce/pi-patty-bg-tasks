/**
 * `bash` 툴 오버라이드.
 *
 * 표준 bash 툴을 확장해 다음 동작을 추가한다:
 *   - 15초 후 자동 백그라운딩 (job_decide 응답 필요)
 *   - 사용자가 Ctrl+Shift+B를 누르면 즉시 백그라운딩
 *   - 2초 안에 완료되면 빠른 종료 경로 (백그라운딩 절차 생략)
 *   - tmux 사용 가능 시 tmux 윈도우로 실행 (race 윈도우 제거)
 */

import { setTimeout as nodeSetTimeout } from "node:timers";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    TMUX_BACKGROUND_POLL_MS,
    type ForegroundSlot,
    type Job,
    type TmuxContext,
    type UiContext,
} from "../types.ts";
import {
    clearTimer,
    getGitRoot,
    killProcessTree,
    killTmuxWindow,
    pollExitSentinel,
    sessionNameForGitRoot,
    spawnDetached,
    spawnTmuxWindow,
} from "../proc.ts";
import {
    add,
    nextJobId,
    logPathFor,
    readLogTail,
    renderSidebar,
} from "../registry.ts";
import {
    completeJob,
    ensureCompletionPromise,
    detectBlockedSleep,
    isAutoBackgroundAllowed,
    isBlankCommand,
    isSignalExit,
    registerJobCleanup,
    requestJobDecision,
    requireExistingCwd,
    scheduleTimeout,
    terminateJobSilently,
    watchProgress,
    watchStalls,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";

/** UI 컨텍스트 + cwd만으로 충분한 축소 인터페이스. */
type BashCtx = UiContext & { cwd: string };

class TmuxBackendUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TmuxBackendUnavailableError";
    }
}

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
            "Run a bash command. Commands auto-background after 15 seconds. " +
            "Use /bg to manually background a running command. Background output is saved to " +
            "/tmp/pi-bg-<jobId>.log.",
        promptSnippet: "Run shell commands; long-running commands auto-background or can be moved with /bg",
        promptGuidelines: [
            "Use bash_bg from the start when a command is expected to run for a long time.",
            "Check status with jobs action='list'.",
            "Read output with jobs action='output'.",
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
                } catch (err) {
                    if (err instanceof TmuxBackendUnavailableError) {
                        // tmux 백엔드 시작 실패 시에만 직접 spawn으로 폴백.
                    } else {
                        throw err;
                    }
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
    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((resolve) => {
        pauseResolve = resolve;
    });
    const requestPause = (reason: "manual" | "timeout") => pauseResolve?.(reason);

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

    let progress: { stop: () => void } | undefined;
    const clearAllTimers = () => {
        progress?.stop();
        clearTimer(timer);
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
                const t = nodeSetTimeout(() => resolve(null), QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            // 빠르게 완료됨 — 즉시 반환.
            clearAllTimers();
            reg.foreground.delete(toolCallId);
            if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
            reg.jobs.delete(id);
            const output = readLogTail(placeholder, OUTPUT_PREVIEW_CHARS);
            if (
                quickResult.code !== 0 &&
                quickResult.code !== null &&
                !quickResult.signal
            ) {
                throw new Error(output || `Command exited with code ${quickResult.code}`);
            }
            return {
                content: [textBlock(output || "(no output)")],
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
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            spawned.exit.then((c) => ({
                kind: "completed" as const,
                code: c,
                signal: isSignalExit(c),
            })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
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
                requestDecision: race.reason === "timeout",
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

        const output = readLogTail(placeholder, OUTPUT_PREVIEW_CHARS);
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
    let tmuxSpawn;
    try {
        tmuxSpawn = spawnTmuxWindow({
            command,
            cwd: ctx.cwd,
            session,
        });
    } catch (err) {
        throw new TmuxBackendUnavailableError(
            `tmux backend unavailable: ${(err as Error).message}`
        );
    }

    const id = `tmux-${process.pid}-${++reg.counter}`;
    const logPath = tmuxSpawn.outputFile;
    const tmuxCtx: TmuxContext = {
        session,
        windowId: tmuxSpawn.windowId,
        exitCodeFile: tmuxSpawn.exitCodeFile,
        outputFile: tmuxSpawn.outputFile,
        gitRoot,
    };

    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((resolve) => {
        pauseResolve = resolve;
    });
    const requestPause = (reason: "manual" | "timeout") => pauseResolve?.(reason);

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
    ensureCompletionPromise(job);
    add(reg, job);

    reg.foreground.set(toolCallId, {
        toolCallId,
        proc: { pid: -1 } as never,
        command,
        logPath,
        requestPause,
    });
    reg.activeToolCallId = toolCallId;

    const foregroundSentinel = new AbortController();
    if (signal) {
        signal.addEventListener("abort", () => {
            foregroundSentinel.abort();
            killTmuxWindow(tmuxCtx.windowId);
        });
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

    // foreground 동안만 빠르게 폴링한다. 백그라운드 전환 시 별도 저속 폴러로 교체한다.
    const completionPromise = pollExitSentinel({
        file: tmuxCtx.exitCodeFile,
        intervalMs: 200,
        signal: foregroundSentinel.signal,
    });

    let progress: { stop: () => void } | undefined;
    const clearAllTimers = () => {
        progress?.stop();
        clearTimer(timer);
    };

    try {
        const quickResult = await Promise.race<number | null>([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = nodeSetTimeout(() => resolve(null), QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            clearAllTimers();
            reg.foreground.delete(toolCallId);
            if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
            reg.jobs.delete(id);
            const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
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
            | { kind: "completed"; code: number | null }
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            completionPromise.then((c) => ({ kind: "completed" as const, code: c })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
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
                onOversize: () => terminateJobSilently(reg, job),
            });

            foregroundSentinel.abort();
            const backgroundSentinel = new AbortController();
            registerJobCleanup(reg, id, () => {
                backgroundSentinel.abort();
                cancelStall();
            });
            pollExitSentinel({
                file: tmuxCtx.exitCodeFile,
                intervalMs: TMUX_BACKGROUND_POLL_MS,
                signal: backgroundSentinel.signal,
            }).then((code) => {
                killTmuxWindow(tmuxCtx.windowId);
                completeJob({ job, code: code ?? undefined, reg, pi, ctx });
            });

            if (race.reason === "timeout") {
                requestJobDecision({
                    reg,
                    ctx,
                    job,
                    timeoutMs,
                });
            }

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

        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        killTmuxWindow(tmuxCtx.windowId);
        if (race.code !== 0) {
            throw new Error(output || `Command exited with code ${race.code ?? "unknown"}`);
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
    requestDecision: boolean;
}): void {
    const cancelStall = watchStalls({
        jobId: args.placeholder.id,
        command: args.command,
        logPath: args.logPath,
        pi: args.pi,
        onOversize: () => terminateJobSilently(args.reg, args.placeholder),
    });
    registerJobCleanup(args.reg, args.placeholder.id, cancelStall);

    args.proc.on("close", (code) => {
        cancelStall();
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

    args.ctx.ui.notify(`Process backgrounded as ${args.placeholder.id}`, "info");
    renderSidebar(args.reg, args.ctx);
    if (args.requestDecision) {
        requestJobDecision({
            reg: args.reg,
            ctx: args.ctx,
            job: args.placeholder,
            timeoutMs: args.timeoutMs,
        });
    }
}

// ─── 보조 ────────────────────────────────────────────────────────────

function gitRootOrThrow(cwd: string): string {
    const root = getGitRoot(cwd);
    if (!root) {
        throw new TmuxBackendUnavailableError(
            "tmux backend requires a git repository. Falling back to direct process management."
        );
    }
    return root;
}

// registerBashTool만 공개 진입점. 다른 export는 의도된 보조.
