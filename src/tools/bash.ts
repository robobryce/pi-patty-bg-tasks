/**
 * `bash` tool override.
 *
 * Single file-descriptor backend (no tmux):
 *   - run_in_background=true spawns immediately and returns a job handle
 *   - foreground commands race completion against backgrounding
 *   - a 2s quick-completion window skips the backgrounding machinery
 *   - Ctrl+Shift+B (manual) or the timeout timer move a command to background
 */

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createBashToolDefinition,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { unlinkSync } from "node:fs";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    type ForegroundSlot,
    type UiContext,
} from "../types.ts";
import { spawnWithFileOutput, killProcessTree } from "../spawn.ts";
import { streamLog } from "../output.ts";
import { showBackgroundHint, clearBackgroundHint } from "../hint.ts";
import {
    add,
    createRunningJob,
    markStarted,
    nextJobId,
    logPathFor,
    readLogTail,
} from "../registry.ts";
import {
    assertJobSlot,
    detectBlockedSleep,
    isAutoBackgroundAllowed,
    isBlankCommand,
    isSignalExit,
    requestJobDecision,
    requireExistingCwd,
    startBackgroundJob,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";
import { bashParamSchema } from "./bash-params.ts";

/** UI context + cwd is all this tool needs from the host context. */
type BashCtx = UiContext & { cwd: string };

/** Register the overridden `bash` tool. */
export function registerBashTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    originalBash: ReturnType<typeof createBashToolDefinition>
): void {
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description:
            "Run a bash command. Long-running commands auto-background after timeout. " +
            "Set run_in_background=true to start in background immediately. " +
            "Use /bg to manually background a running command.",
        promptSnippet:
            "Run shell commands; long-running commands auto-background or use run_in_background=true",
        promptGuidelines: [
            "Use bash with run_in_background=true when a command is expected to run for a long time.",
            "run_in_background is for ONE notification (the command exits when done). For per-event streaming (watching logs, polling an API, file changes), use the monitor tool instead.",
            "Check background job status with jobs action='list'.",
            "Read background output with jobs action='output'.",
        ],
        parameters: bashParamSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const p = params as {
                command: string;
                timeout?: number;
                run_in_background?: boolean;
                description?: string;
            };
            const bashCtx = ctx as BashCtx;

            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);

            const sleepMatch = detectBlockedSleep(p.command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash with run_in_background=true for long waits.`
                );
            }

            assertJobSlot(reg);

            // Explicit background mode — spawn and return immediately.
            if (p.run_in_background) {
                return spawnBackground({
                    toolCallId,
                    command: p.command,
                    name: p.description,
                    cwd: bashCtx.cwd,
                    reg,
                    pi,
                    ctx: bashCtx,
                });
            }

            // Foreground mode — race completion against backgrounding.
            return runForeground({
                toolCallId,
                command: p.command,
                timeoutMs: p.timeout ? p.timeout * 1000 : DEFAULT_TIMEOUT_MS,
                signal,
                onUpdate,
                ctx: bashCtx,
                reg,
                pi,
            });
        },
    });
}

// --- Foreground backend --------------------------------------------------

async function runForeground(args: {
    toolCallId: string;
    command: string;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined;
    ctx: BashCtx;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
}): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const { toolCallId, command, timeoutMs, signal, onUpdate, ctx, reg, pi } =
        args;
    const id = nextJobId(reg);
    const logPath = logPathFor(id);

    // Spawn WITHOUT wiring the turn signal to a process kill. Cooperative
    // steering aborts the turn (ctx.abort) to move this command to the
    // background; if the turn signal killed the process group, that abort would
    // kill the very command we just backgrounded. We manage the signal manually
    // below and only kill on a genuine cancel (abort with no pause requested).
    const spawned = spawnWithFileOutput({
        command,
        cwd: ctx.cwd,
        logPath,
    });

    // Register the foreground slot so Ctrl+Shift+B can find this command.
    let pauseRequested = false;
    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((r) => {
        pauseResolve = r;
    });
    const requestPause = (reason: "manual" | "timeout") => {
        pauseRequested = true;
        pauseResolve?.(reason);
    };

    // A turn abort with no pause request is a genuine cancel (e.g. Esc) — kill
    // the process group. A turn abort after a pause request is cooperative
    // steering moving the command to the background — leave it running.
    const onTurnAbort = () => {
        if (!pauseRequested) killProcessTree(spawned.pid, "SIGTERM");
    };
    if (signal) {
        if (signal.aborted) onTurnAbort();
        else signal.addEventListener("abort", onTurnAbort);
    }

    const slot: ForegroundSlot = { requestPause };
    reg.foreground.set(toolCallId, slot);
    reg.activeToolCallId = toolCallId;

    const job = createRunningJob({
        id,
        command,
        pid: spawned.pid,
        logPath,
        toolCallId,
        isBackgrounded: false,
    });
    // Foreground jobs are tracked for the sidebar / Ctrl+Shift+B but not counted
    // as "started" until they actually move to the background (see below).
    reg.jobs.set(id, job);

    // Timeout timer.
    const timeoutTimer = setTimeout(() => {
        if (reg.nonInteractive) return;
        if (!reg.foreground.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killProcessTree(spawned.pid, "SIGTERM");
            return;
        }
        requestPause("timeout");
    }, timeoutMs);
    (timeoutTimer as NodeJS.Timeout).unref();

    let progressPoller: { stop: () => void } | undefined;
    let handedToBackground = false;
    let hintShown = false;

    const cleanup = () => {
        progressPoller?.stop();
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onTurnAbort);
    };

    // Foreground completion (quick or normal): read output, surface errors.
    // Registry teardown happens in `finally` so no exit path can strand the job.
    const finishForeground = (
        code: number | null
    ): AgentToolResult<BashToolDetails | undefined> => {
        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        if (code !== 0 && code !== null && !isSignalExit(code)) {
            throw new Error(output || `Command exited with code ${code}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    };

    try {
        // Quick completion window (2s).
        const quickResult = await Promise.race<{ code: number | null } | null>([
            spawned.exit.then((c) => ({ code: c })),
            new Promise<null>((r) => {
                const t = setTimeout(() => r(null), QUICK_COMPLETION_MS);
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            return finishForeground(quickResult.code);
        }

        // Still running past the quick window — start progress polling and show
        // the "(ctrl+b to run in background)" hint, like Claude Code.
        progressPoller = streamLog(logPath, onUpdate);
        showBackgroundHint(ctx);
        hintShown = true;

        // Race: completion vs backgrounding.
        const race = await Promise.race<
            | { kind: "completed"; code: number | null }
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            spawned.exit.then((c) => ({ kind: "completed" as const, code: c })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);

        if (race.kind === "backgrounded") {
            handedToBackground = true;
            job.isBackgrounded = true;
            // Foreground job promoted to background — now count it as started.
            markStarted(reg);
            startBackgroundJob({ reg, pi, ctx, job, exit: spawned.exit });

            if (race.reason === "timeout") {
                requestJobDecision({ reg, pi, ctx, job, timeoutMs });
            }

            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${id}\nCommand: ${command}\nPID: ${spawned.pid}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        // Normal completion.
        return finishForeground(race.code);
    } finally {
        // Single teardown for every exit path (return, throw, background hand-off).
        cleanup();
        if (hintShown) clearBackgroundHint(ctx);
        reg.foreground.delete(toolCallId);
        if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
        if (!handedToBackground) {
            reg.jobs.delete(id);
            try { unlinkSync(logPath); } catch { /* best-effort */ }
        }
    }
}

// --- Background backend --------------------------------------------------

function spawnBackground(args: {
    toolCallId: string;
    command: string;
    name?: string;
    cwd: string;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): AgentToolResult<BashToolDetails | undefined> {
    const id = nextJobId(args.reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command: args.command,
        cwd: args.cwd,
        logPath,
    });

    const job = createRunningJob({
        id,
        name: args.name,
        command: args.command,
        pid: spawned.pid,
        logPath,
        toolCallId: args.toolCallId,
    });
    add(args.reg, job);
    startBackgroundJob({ reg: args.reg, pi: args.pi, ctx: args.ctx, job, exit: spawned.exit });

    return {
        content: [
            textBlock(
                `Command running in background with ID: ${id}.${
                    args.name ? ` Name: ${args.name}.` : ""
                } Output is being written to: ${logPath}`
            ),
        ],
        details: undefined,
    };
}
