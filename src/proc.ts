/**
 * Process-management primitives: spawn, kill, liveness probe, tmux polling.
 *
 * All operations are synchronous and stateless — they take the resources
 * they need as explicit arguments. The orchestration (when to spawn, when
 * to kill, what to do with the result) lives in `lifecycle.ts` and the
 * tool registrations.
 */

import { spawn, execSync } from "node:child_process";
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { TmuxContext } from "./types.ts";

// ─── 프로세스 스폰 ────────────────────────────────────────────────────────────────────────────

export interface SpawnedProcess {
    proc: ReturnType<typeof spawn>;
    logPath: string;
    /** Resolves when the child exits. null if the child errored before spawn. */
    exit: Promise<number | null>;
}

/**
 * Spawn `bash -c <command>` with stdout+stderr tee'd to `logPath`. The child
 * is detached (process group leader) so we can SIGTERM the whole tree.
 */
export function spawnDetached(
    command: string,
    cwd: string,
    logPath: string
): SpawnedProcess {
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "w");
    const proc = spawn("bash", ["-c", command], {
        stdio: ["pipe", logFd, logFd],
        cwd,
        detached: true,
        env: { ...process.env },
    });
    closeSync(logFd);

    if (!proc.pid) throw new Error("Failed to spawn process");

    const exit = new Promise<number | null>((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    });

    return { proc, logPath, exit };
}

// ─── 프로세스 그룹 종료 ────────────────────────────────────────────────────────────────────────────

/** Kill an entire process group. Requires the child to have been spawned
 *  with `detached: true` so it became a process group leader. */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap "is the process alive?" probe via signal 0. EPERM means alive-but-no-permission. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Idempotent clearTimeout that accepts null/undefined. */
export function clearTimer(
    timer: NodeJS.Timeout | null | undefined
): void {
    if (timer) clearTimeout(timer);
}

// ─── Tmux: 가용성 + 세션 이름 ────────────────────────────────────────────────────────────────

let cachedTmuxAvailable: boolean | undefined;

/** Detect whether tmux is on PATH. Cached per-process. */
export function isTmuxAvailable(): boolean {
    if (cachedTmuxAvailable !== undefined) return cachedTmuxAvailable;
    try {
        execSync("which tmux 2>/dev/null", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: "pipe",
        });
        cachedTmuxAvailable = true;
    } catch {
        cachedTmuxAvailable = false;
    }
    return cachedTmuxAvailable;
}

/** Quote a value for safe shell embedding. Handles embedded single quotes. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Per-process tmux run directory, memoised. */
let cachedRunDir: string | undefined;
export function tmuxRunDir(): string {
    if (cachedRunDir) return cachedRunDir;
    const dir = `/tmp/pi-tmux-${process.pid}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedRunDir = dir;
    return dir;
}

/** Determine the background tmux session name for a given git root. */
export function sessionNameForGitRoot(gitRoot: string): string {
    const slug =
        gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project";
    const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
    return `pi-bg-${slug}-${hash}`;
}

/** Get the git root for a directory, or null if not in a git repo. */
export function getGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch {
        return null;
    }
}

// ─── Tmux: 윈도우 생성 + 센티널 기반 종료 감지 ──────────────────────────────────────────────

/**
 * Write a wrapper script that runs `command` inside the given output/exit
 * files. The exit-code sentinel file is the inter-process signal we use
 * to detect completion (the kernel pipe buffer doesn't survive across
 * the tmux PTY boundary reliably).
 */
export function writeWrapperScript(args: {
    runDir: string;
    session: string;
    command: string;
    outputFile: string;
    exitCodeFile: string;
}): { scriptPath: string } {
    const scriptDir = join(args.runDir, "s");
    mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
    chmodRecursive(scriptDir, 0o700);

    const scriptPath = join(
        scriptDir,
        `${args.session}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sh`
    );

    writeFileAtomic(
        scriptPath,
        `#!/usr/bin/env bash
__output_file=${shellQuote(args.outputFile)}
__exit_code_file=${shellQuote(args.exitCodeFile)}
(
${args.command}
) >> "$__output_file" 2>&1
printf '%s\\n' "$?" > "$__exit_code_file"
`,
        0o755
    );

    return { scriptPath };
}

function chmodRecursive(p: string, mode: number): void {
    try {
        chmodSync(p, mode);
    } catch {
        /* directory may not exist yet */
    }
}

function writeFileAtomic(p: string, content: string, mode: number): void {
    writeFileSync(p, content, { mode });
    chmodSync(p, mode);
}

/** Check if a tmux session with the given name exists. */
export function tmuxSessionExists(name: string): boolean {
    return (
        execSafe(`tmux has-session -t ${shellQuote(name)} 2>/dev/null && echo yes`) ===
        "yes"
    );
}

/** Run a shell command, returning trimmed stdout or null on failure. */
function execSafe(cmd: string): string | null {
    try {
        return execSync(cmd, {
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * Spawn `command` inside a fresh tmux window in `session`. Returns the
 * window id, the run id (used for output/sentinel file paths), and those
 * paths.
 */
export function spawnTmuxWindow(args: {
    command: string;
    cwd: string;
    session: string;
}): { windowId: string; id: string; outputFile: string; exitCodeFile: string } {
    const runDir = tmuxRunDir();
    const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const exitCodeFile = join(runDir, `${args.session}.${id}.exit`);
    const outputFile = join(runDir, `${args.session}.${id}.out`);

    const { scriptPath } = writeWrapperScript({
        runDir,
        session: args.session,
        command: args.command,
        outputFile,
        exitCodeFile,
    });

    const windowName = args.command.split(/\s/)[0]?.slice(0, 30) ?? "shell";

    // TOCTOU 회피: 세션 존재 확인 없이 new-window 시도 → 실패 시 new-session 폴백.
    let windowId: string;
    try {
        windowId = execSync(
            `tmux new-window -d -t ${shellQuote(args.session)} -n ${shellQuote(windowName)} -c ${shellQuote(args.cwd)} -P -F '#{window_id}' ${shellQuote(scriptPath)}`,
            { encoding: "utf-8", timeout: 10_000, stdio: "pipe" }
        ).trim();
    } catch {
        windowId = execSync(
            `tmux new-session -d -s ${shellQuote(args.session)} -n ${shellQuote(windowName)} -c ${shellQuote(args.cwd)} -P -F '#{window_id}' ${shellQuote(scriptPath)}`,
            { encoding: "utf-8", timeout: 10_000, stdio: "pipe" }
        ).trim();
    }

    return { windowId, id, outputFile, exitCodeFile };
}

/** Kill a tmux window by id. */
export function killTmuxWindow(windowId: string): void {
    try {
        execSync(`tmux kill-window -t ${shellQuote(windowId)}`, {
            timeout: 3000,
            stdio: "pipe",
        });
    } catch {
        /* window already gone */
    }
}

/** Capture the last N lines of a tmux pane, falling back to a tee'd file. */
export function capturePane(windowId: string, lines: number, outputFile?: string): string {
    if (outputFile) {
        try {
            const content = readFileSync(outputFile, "utf-8");
            if (content.length > 0) return content;
        } catch {
            // 파일이 아직 없거나 삭제됨 — tmux capture로 폴백.
        }
    }
    try {
        const raw = execSync(
            `tmux capture-pane -t ${shellQuote(windowId)} -p -S -${lines}`,
            { encoding: "utf-8", timeout: 10_000, stdio: "pipe" }
        );
        return raw ?? "(no output)";
    } catch {
        return "(no output)";
    }
}

/**
 * sentinel 파일을 폴링하여 종료 코드를 기다린다.
 * maxPolls 초과 시 null 반환 (타임아웃 → 실패 처리 위임).
 */
export function pollExitSentinel(args: {
    file: string;
    intervalMs?: number;
    maxPolls?: number;
    maxDurationMs?: number;
    signal?: AbortSignal;
}): Promise<number | null> {
    const intervalMs = args.intervalMs ?? 500;
    const maxDurationMs = args.maxDurationMs ?? 6 * 60 * 60 * 1000;
    const deadline = Date.now() + maxDurationMs;
    return new Promise((resolve) => {
        let count = 0;
        let settled = false;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            args.signal?.removeEventListener("abort", onAbort);
            resolve(code);
        };
        const onAbort = () => finish(null);
        const timer = setInterval(() => {
            if (args.signal?.aborted) {
                finish(null);
                return;
            }
            if (
                (args.maxPolls !== undefined && ++count > args.maxPolls) ||
                (args.maxPolls === undefined && Date.now() > deadline)
            ) {
                finish(null);
                return;
            }
            const code = readExitSentinel(args.file);
            if (code !== undefined) finish(code);
        }, intervalMs);
        args.signal?.addEventListener("abort", onAbort, { once: true });
        timer.unref();
    });
}

/** Read the exit-code sentinel file. Returns undefined if not yet written. */
export function readExitSentinel(file: string): number | undefined {
    if (!existsSync(file)) return undefined;
    const content = readFileSync(file, "utf-8").trim();
    const code = parseInt(content);
    if (!Number.isFinite(code)) return undefined;
    return code;
}

// ─── Tmux 컨텍스트 헬퍼 재export ────────────────────────────────────────────────────────────

export type { TmuxContext };
