/**
 * 백그라운드 잡의 수명 주기를 관리하는 라이프사이클 헬퍼들.
 *
 * 진행률 폴링, 정체 감시, 완료 통지, 타임아웃 스케줄링, 잡 종료 표시,
 * 정리(킬) 같은 횡단 관심사를 한곳에 모았다.
 */

import { readdirSync, statSync as fsStatSync, rmSync, unlinkSync as fsUnlink } from "node:fs";
import { join as pathJoin } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_TIMEOUT_MS,
    EVENT,
    type Job,
    type JobStatus,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import {
    killProcessTree,
    killTmuxWindow,
    processExists,
    readExitSentinel,
} from "./proc.ts";
import { findJob, forget, renderSidebar } from "./registry.ts";
import { formatDuration } from "./format.ts";
export { watchProgress, watchStalls } from "./monitoring.ts";

// ─── 잡 종료 표시 ────────────────────────────────────────────────────

/**
 * 잡 종료 후 표준 완료 흐름 — markTerminal → notifyFinished → forget → renderSidebar.
 * 모든 툴(bash, bash_bg, agent_bg)의 proc.on("close") / sentinel 폴링 콜백에서
 * 공유하는 표준 종료 프로토콜.
 */
export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    const finished = findJob(args.reg, args.job.id) ?? args.job;
    runJobCleanup(args.reg, finished.id);
    markTerminal(finished, statusFromExit(args.code), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
    }
    forget(args.reg, finished);
    renderSidebar(args.reg, args.ctx);
}

/**
 * 잡을 터미널 상태로 표시하고 donePromise를 해소한다. 멱등성 보장 —
 * 이미 터미널이면 무시한다. proc 참조는 GC를 위해 명시적으로 제거한다.
 */
export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** 종료 코드를 JobStatus로 매핑. null은 시그널 종료(취소)로 간주하여 completed. */
export function statusFromExit(code: number | null | undefined): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

/**
 * 잡 donePromise를 생성한다. attach/log-wait 흐름에서 결과를 기다리는
 * 진입점이 된다.
 */
/** 멱등성 보장 — 이미 donePromise가 있으면 재생성하지 않는다. */
export function ensureCompletionPromise(job: Job): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

/**
 * 잡을 "killed"로 표시하고 출력 소비 플래그를 켠다. 모든 종료 경로에서
 * proc.on("close")가 가짜 완료 통지를 보내는 것을 막기 위해 사용한다.
 */
export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    job.outputConsumed = true;
}

/** 잡을 조용히 종료하고 등록된 타이머/폴러까지 정리한다. */
export function terminateJobSilently(reg: BackgroundRegistry, job: Job): void {
    terminateJob(job);
    markKilledSilently(job);
    runJobCleanup(reg, job.id);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
}

/** 종료 코드 패턴이 SIGKILL/SIGTERM인지 확인한다 — 정상 종료를 기대하는
 *  호출자가 의도된 취소로 취급할 수 있도록 한다. */
export function isSignalExit(code: number | null | undefined): boolean {
    return code === 137 || code === 143;
}

// ─── 잡 정리 ─────────────────────────────────────────────────────────

/** 잡별 타이머/폴러 정리 콜백을 등록한다. */
export function registerJobCleanup(
    reg: BackgroundRegistry,
    jobId: string,
    cleanup: () => void
): void {
    const set = reg.jobCleanups.get(jobId) ?? new Set<() => void>();
    set.add(cleanup);
    reg.jobCleanups.set(jobId, set);
}

/** 잡별 타이머/폴러를 한 번만 정리한다. */
export function runJobCleanup(reg: BackgroundRegistry, jobId: string): void {
    const cleanups = reg.jobCleanups.get(jobId);
    if (!cleanups) return;
    reg.jobCleanups.delete(jobId);
    for (const cleanup of cleanups) {
        try {
            cleanup();
        } catch {
            /* 정리는 best-effort */
        }
    }
}

/**
 * 잡을 정리한다 — tmux 창이면 kill-window, 살아있는 프로세스 그룹이면
 * SIGTERM, 재수화(rehydrated) 잡의 경우 proc 핸들이 없어도 PID로 직접
 * 시그널을 보낸다.
 */
export function terminateJob(job: Job): void {
    if (job.tmux) {
        killTmuxWindow(job.tmux.windowId);
        return;
    }
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}

// ─── 포그라운드 백그라운딩 ───────────────────────────────────────────

/** 현재 포그라운드 명령을 백그라운드로 넘기고 에이전트 follow-up을 보낸다. */
export function backgroundActiveForeground(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: UiContext
): boolean {
    if (!reg.activeToolCallId) return false;
    const toolCallId = reg.activeToolCallId;
    const slot = reg.foreground.get(toolCallId);
    if (!slot) return false;

    slot.requestPause("manual");
    reg.foreground.delete(toolCallId);
    if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
    renderSidebar(reg, ctx);
    ctx.ui.notify("▶ Backgrounded — continuing.", "info");
    pi.sendMessage(
        {
            customType: EVENT.background,
            content:
                `Command was manually backgrounded by user. ` +
                `Output is being captured. ` +
                `You can continue working — use the jobs tool to check on it later.`,
            display: true,
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
    return true;
}

// ─── 타임아웃 ────────────────────────────────────────────────────────

/**
 * `requestPause`를 트리거하는 타임아웃 타이머를 시작한다. 비-인터랙티브
 * 모드에서는 job_decide 응답자가 없으므로 백그라운딩하지 않는다.
 * 호출자가 조기 종료 시 반드시 clearTimer로 정리해야 한다.
 */
export function scheduleTimeout(args: {
    requestPause: (reason: "timeout") => void;
    command: string;
    reg: BackgroundRegistry;
    toolCallId: string;
    explicitMs?: number;
    isAutoBackgroundAllowed: (command: string) => boolean;
}): NodeJS.Timeout {
    const ms = args.explicitMs ?? DEFAULT_TIMEOUT_MS;
    const t = nodeSetTimeout(() => {
        if (args.reg.nonInteractive) return;
        if (!args.reg.foreground.has(args.toolCallId)) return;
        if (!args.isAutoBackgroundAllowed(args.command)) {
            const slot = args.reg.foreground.get(args.toolCallId);
            if (slot?.proc.pid) killProcessTree(slot.proc.pid, "SIGTERM");
            return;
        }
        args.requestPause("timeout");
    }, ms);
    t.unref();
    return t;
}

// ─── 완료 통지 ───────────────────────────────────────────────────────

/**
 * 잡이 완료되었음을 에이전트에게 통지한다. outputConsumed가 true면
 * (예: /jobs attach가 이미 출력 소비함) 통지를 보내지 않고 정리만 한다.
 * 통지 직후 registry에서 forget()하여 메모리에서 제거한다.
 */
export function notifyFinished(args: {
    job: Job;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): void {
    const { job, pi, ctx } = args;
    if (job.outputConsumed) {
        // 출력은 이미 소비됨 — 통지 없이 정리.
        // registry.forget은 호출 측에서 처리.
        return;
    }

    const duration = formatDuration(Date.now() - job.startTime);
    const label = job.name ? `"${job.name}"` : `"${job.command.slice(0, 60)}"`;
    const statusText =
        job.status === "completed"
            ? `Background bash ${label} completed (${duration})`
            : `Background bash ${label} ${job.status} (${duration})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(
        statusText,
        job.status === "completed" ? "info" : "error"
    );

    pi.sendMessage(
        {
            customType: EVENT.jobFinished,
            content:
                `${statusText}${exitCodeText}\n` +
                `Task ID: ${job.id}\n` +
                `Output file: ${job.logPath}`,
            display: true,
            details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
                duration,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "steer" }
    );
}

/**
 * 타임아웃 후 백그라운딩되었음을 에이전트에게 알리는 follow-up 메시지를
 * 만든다. 직접 spawn / tmux 백엔드 양쪽에서 동일한 메시지 형태를 보장한다.
 */
export function buildTimeoutNotice(args: {
    jobId: string;
    command: string;
    logPath: string;
    timeoutMs: number;
    location: { kind: "pid"; pid: number } | { kind: "tmux"; windowId: string };
}): { content: string; details: Record<string, unknown> } {
    const where =
        args.location.kind === "pid"
            ? `PID: ${args.location.pid}`
            : `Tmux window: ${args.location.windowId}`;
    const attachHint =
        args.location.kind === "tmux"
            ? `You can attach to the tmux window with: tmux attach -t ${args.location.windowId}`
            : `Do NOT use jobs action "attach" on this job — it will block indefinitely.`;
    return {
        content:
            `Command running in background with ID: ${args.jobId}. Output is being written to: ${args.logPath}\n\n` +
            `Command: ${args.command}\n` +
            `${where}\n` +
            `Timed out after: ${formatDuration(args.timeoutMs)}\n\n` +
            `Use the job_decide tool with jobId "${args.jobId}" to decide:\n` +
            `- decision "check": inspect the output first\n` +
            `- decision "keep": let it continue running\n` +
            `- decision "kill": terminate it\n\n` +
            attachHint,
        details: {
            jobId: args.jobId,
            logPath: args.logPath,
            command: args.command,
        },
    };
}

/** 타임아웃 의사결정 요청을 기록하고 에이전트 follow-up으로 전달한다. */
export function requestJobDecision(args: {
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    job: Job;
    timeoutMs: number;
    location: { kind: "pid"; pid: number } | { kind: "tmux"; windowId: string };
}): void {
    args.reg.pendingDecisionJobId = args.job.id;
    const notice = buildTimeoutNotice({
        jobId: args.job.id,
        command: args.job.command,
        logPath: args.job.logPath,
        timeoutMs: args.timeoutMs,
        location: args.location,
    });
    args.pi.sendMessage(
        {
            customType: EVENT.timeout,
            content: notice.content,
            display: true,
            details: notice.details,
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

// ─── 보조 ────────────────────────────────────────────────────────────

/** cwd가 실제로 존재하는지 확인. 존재하지 않으면 명확한 에러를 던진다. */
export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** 공백뿐인 명령인지 확인한다. bash는 빈 명령을 에러 없이 통과시키므로 명시적으로 거부한다. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

/**
 * 자동 백그라운딩이 허용되는 명령인지 확인한다. sleep 같이 백그라운딩이
 * 무의미한 명령을 거부한다.
 */
const DISALLOWED_AUTO_BACKGROUND = new Set(["sleep"]);
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND.has(base);
}

/**
 * 2초 이상의 sleep을 거부한다. bash의 foreground sleep은 사용자 인터랙티브
 * 흐름을 차단하므로 long-running 작업은 bash_bg를 사용해야 한다.
 */
export function detectBlockedSleep(command: string): string | null {
    const first =
        command
            .trim()
            .split(/&&|;|\|/)[0]
            ?.trim() ?? "";
    const m = /^sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(first);
    if (!m) return null;
    const secs = parseFloat(m[1]);
    if (secs < 2) return null;
    return first;
}

// ─── 재수화 (session restore) ────────────────────────────────────────

/**
 * 직렬화된 세션 항목에서 재수화된 잡의 상태를 검증한다. PID가 죽었거나
 * tmux 종료 코드가 기록되어 있으면 completed로 강제 전환한다.
 */
export function reviveAndValidate(
    _reg: BackgroundRegistry,
    job: Job
): "alive" | "completed" {
    if (job.status !== "running") return "completed";

    if (job.tmux) {
        const sentinel = job.tmux.exitCodeFile;
        const code = readExitSentinel(sentinel);
        if (code !== undefined) {
            markTerminal(job, statusFromExit(code), code);
            return "completed";
        }
        return "alive";
    }
    if (!processExists(job.pid)) {
        markTerminal(job, "failed");
        return "completed";
    }
    return "alive";
}

// ─── 비-인터랙티브 모드 감지 ─────────────────────────────────────────

/** pi가 비-인터랙티브 모드로 실행 중인지 감지 (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

// ─── 정리 (cleanup) ─────────────────────────────────────────────────

/** 24시간 이상된 로그와 죽은 pi 프로세스의 tmux 잔여물을 한 번의 /tmp 스캔으로 정리한다. */
export function cleanupStaleRuntimeArtifacts(args: { tmuxAvailable: boolean }): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    let entries;
    try {
        entries = readdirSync("/tmp", { withFileTypes: true });
    } catch {
        return;
    }

    const now = Date.now();
    for (const entry of entries) {
        const fullPath = pathJoin("/tmp", entry.name);
        if (entry.isFile() && entry.name.startsWith("pi-bg-")) {
            try {
                const { mtimeMs } = fsStatSync(fullPath);
                if (now - mtimeMs > MAX_AGE_MS) fsUnlink(fullPath);
            } catch {
                /* 이미 사라진 파일 */
            }
            continue;
        }

        if (!args.tmuxAvailable || !entry.name.startsWith("pi-tmux-")) continue;
        const pid = parseInt(entry.name.replace("pi-tmux-", ""), 10);
        if (!Number.isFinite(pid) || pid === process.pid) continue;
        try {
            process.kill(pid, 0);
            continue;
        } catch {
            /* 죽은 PID */
        }
        try {
            rmSync(fullPath, { recursive: true, force: true });
        } catch {
            /* 권한 에러 또는 동시 정리 */
        }
    }
}
