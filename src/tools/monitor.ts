// src/tools/monitor.ts
//
// `monitor` tool — a streaming-event background watch. Each stdout line (or
// WebSocket text frame) becomes one notification delivered into the agent's
// turn. This is distinct from bash_bg/run_in_background (one notification on
// completion): monitor is for per-event streams (tail -f | grep, poll loops,
// file watches, ws feeds), not one-shot "wait until done".

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import {
    EVENT,
    MONITOR_DEFAULT_TIMEOUT_MS,
    MONITOR_MAX_LINES_PER_WINDOW,
    MONITOR_MAX_TIMEOUT_MS,
    MONITOR_RATE_WINDOW_MS,
    type Job,
    type UiContext,
} from "../types.ts";
import { spawnWithFileOutput } from "../spawn.ts";
import { add, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    assertJobSlot,
    isBlankCommand,
    requireExistingCwd,
    startBackgroundJob,
    terminateJobSilently,
} from "../lifecycle.ts";
import { followLines, type MonitorFollower } from "../monitor-follow.ts";
import { isWsSupported, openWsSource, type WsSpec } from "../monitor-ws.ts";
import { textBlock } from "../format.ts";

type MonitorCtx = UiContext & { cwd: string };

interface MonitorParams {
    command?: string;
    ws?: WsSpec;
    description: string;
    persistent?: boolean;
    timeout_ms?: number;
}

export function registerMonitorTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "monitor",
        label: "Monitor",
        description:
            "Stream events from a long-running process: each stdout line (or WebSocket " +
            "text frame) becomes one notification, delivered while you keep working. " +
            "Use this for per-event streams — NOT for one-shot 'wait until done' (use " +
            "bash run_in_background for that). Exit ends the watch.",
        promptSnippet:
            "Stream per-event notifications from a process, log, poll loop, or WebSocket",
        promptGuidelines: [
            "Pick by notification count: ONE ('tell me when done') → bash run_in_background with an `until` loop that exits; ONE-PER-EVENT → monitor.",
            "Don't use an unbounded command (tail -f, while true, inotifywait -m) for a single notification — it never exits and stays armed until timeout.",
            "Every pipe stage must flush per line: grep needs --line-buffered, awk needs fflush(); never pipe to `head` (it buffers until N matches).",
            "Silence is not success: your filter must match failure signatures too (e.g. grep -E --line-buffered 'done|Traceback|Error|FAILED|Killed|OOM'), or a crash looks identical to 'still running'.",
            "Only stdout is the event stream; merge stderr with 2>&1 if its failures should notify. Poll remote APIs at 30s+, local checks at 0.5–1s, and guard transient failures with `|| true`.",
            "Give a specific description — it is shown on every notification.",
            "Use persistent:true for session-length watches (PR monitoring, log tails); stop it with the jobs tool (action='kill').",
            "Use the ws source for a WebSocket feed instead of `command: 'websocat …'` — each text frame becomes one event.",
        ],
        parameters: Type.Object({
            command: Type.Optional(
                Type.String({ description: "Shell script; each stdout line is an event. Mutually exclusive with ws." })
            ),
            ws: Type.Optional(
                Type.Object(
                    {
                        url: Type.String({ description: "WebSocket URL (ws:// or wss://)" }),
                        protocols: Type.Optional(Type.Array(Type.String())),
                    },
                    { description: "WebSocket source; each text frame is an event. Mutually exclusive with command." }
                )
            ),
            description: Type.String({ description: "Specific description, shown on every notification." }),
            persistent: Type.Optional(
                Type.Boolean({ description: "Run for the whole session (no timeout). Stop via jobs action='kill'. Default false." })
            ),
            timeout_ms: Type.Optional(
                Type.Number({ description: "Kill after this deadline (default 300000, max 3600000). Ignored when persistent." })
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as MonitorParams;
            const mctx = ctx as MonitorCtx;

            // --- Validation: command XOR ws -------------------------------
            const hasCommand = typeof p.command === "string" && !isBlankCommand(p.command);
            const hasWs = !!p.ws && typeof p.ws.url === "string" && p.ws.url.length > 0;
            if (hasCommand && hasWs) {
                throw new Error("Provide either `command` or `ws`, not both.");
            }
            if (!hasCommand && !hasWs) {
                throw new Error("A monitor needs a `command` or a `ws` source.");
            }
            if (!p.description || p.description.trim().length === 0) {
                throw new Error("`description` is required (shown on every notification).");
            }
            if (hasWs && !isWsSupported()) {
                throw new Error(
                    "WebSocket is not available in this runtime (needs Node 22+). " +
                        `Use command: 'websocat ${p.ws!.url}' or 'wscat -c ${p.ws!.url}' instead.`
                );
            }
            if (hasCommand) requireExistingCwd(mctx.cwd);
            assertJobSlot(reg);

            const description = p.description.trim();
            const persistent = p.persistent === true;
            const timeoutMs = Math.min(
                p.timeout_ms && p.timeout_ms > 0 ? p.timeout_ms : MONITOR_DEFAULT_TIMEOUT_MS,
                MONITOR_MAX_TIMEOUT_MS
            );

            const id = nextJobId(reg);
            const logPath = logPathFor(id);

            // --- Start the source -----------------------------------------
            let exit: Promise<number | null>;
            let pid = 0;
            let wsClose: (() => void) | undefined;
            let commandLabel: string;

            if (hasWs) {
                const source = openWsSource(p.ws!, logPath);
                exit = source.exit;
                wsClose = source.close;
                commandLabel = `ws ${p.ws!.url}`;
            } else {
                const errPath = logPath.replace(/\.log$/, ".err");
                const spawned = spawnWithFileOutput({
                    command: p.command!,
                    cwd: mctx.cwd,
                    logPath,
                    errPath,
                });
                exit = spawned.exit;
                pid = spawned.pid;
                commandLabel = p.command!;
            }

            const job: Job = {
                id,
                command: commandLabel,
                pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                toolCallId: _toolCallId,
                isBackgrounded: true,
                kind: "monitor",
            };
            add(reg, job);

            // --- Event emission + rate limiting ---------------------------
            let terminalEmitted = false;
            let finishing = false;
            let windowStart = Date.now();
            let windowLines = 0;

            const emitEvent = (lines: string[]): void => {
                if (lines.length === 0) return;
                pi.sendMessage(
                    {
                        customType: EVENT.monitorEvent,
                        content: `◉ ${description}\n${lines.join("\n")}`,
                        display: true,
                        details: { jobId: id, description, logPath },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
            };

            const follower: MonitorFollower = followLines(logPath, (lines) => {
                if (terminalEmitted) return;

                // Sliding-window firehose check.
                const now = Date.now();
                if (now - windowStart > MONITOR_RATE_WINDOW_MS) {
                    windowStart = now;
                    windowLines = 0;
                }
                windowLines += lines.length;

                emitEvent(lines);

                // Don't trip the firehose guard while draining the final flush.
                if (!finishing && windowLines > MONITOR_MAX_LINES_PER_WINDOW) {
                    stopMonitor(`stopped: too many events (>${MONITOR_MAX_LINES_PER_WINDOW}/${MONITOR_RATE_WINDOW_MS / 1000}s) — restart with a tighter filter`);
                }
            });

            // job.stop: transient teardown invoked by the kill path.
            job.stop = () => {
                follower.stop(false);
                wsClose?.();
            };

            const finishMonitor = (summary: string, _isError: boolean): void => {
                if (terminalEmitted) return;
                // Flush remaining lines first (while terminalEmitted is still
                // false so the follower callback emits them), then the summary.
                finishing = true;
                follower.stop(true);
                terminalEmitted = true;
                pi.sendMessage(
                    {
                        customType: EVENT.monitorEvent,
                        content: `◉ ${description} — ${summary}`,
                        display: true,
                        details: { jobId: id, description, logPath, terminal: true },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
            };

            /** Forced stop (timeout / firehose). Emits a terminal event, then
             *  routes through the standard silent-kill path (which calls job.stop). */
            function stopMonitor(summary: string): void {
                finishMonitor(summary, true);
                terminateJobSilently(reg, job);
                renderSidebar(reg, mctx);
            }

            // Wire exit → terminal event. shouldNotify:false because the monitor
            // owns its own terminal event (no jobFinished double-fire).
            startBackgroundJob({
                reg,
                pi,
                ctx: mctx,
                job,
                exit,
                shouldNotify: false,
                onExit: (code) => {
                    const summary =
                        code === 0 || code === null
                            ? "stream ended"
                            : `script failed (exit ${code})`;
                    finishMonitor(summary, code !== 0 && code !== null);
                },
            });

            // Deadline (skipped for persistent watches).
            if (!persistent) {
                const timer = setTimeout(() => {
                    stopMonitor(`stopped (timeout after ${Math.round(timeoutMs / 1000)}s)`);
                }, timeoutMs);
                (timer as NodeJS.Timeout).unref();
            }

            const sourceDesc = hasWs ? `WebSocket ${p.ws!.url}` : "command";
            const deadlineDesc = persistent
                ? "persistent (stop via jobs action='kill')"
                : `timeout ${Math.round(timeoutMs / 1000)}s`;
            return {
                content: [
                    textBlock(
                        `Monitor ${id} started — ${sourceDesc}, ${deadlineDesc}. ` +
                            `Events ("${description}") will arrive as notifications. ` +
                            `Output: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        },
    });
}
