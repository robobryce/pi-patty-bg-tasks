/**
 * `agent_bg` tool — runs a separate `pi -p` process in the background.
 *
 * Builds a continuity prompt from the current session's first user prompt and
 * latest assistant message, then spawns a detached `pi -p` process with the
 * same model. Output is written to the job log and surfaced live via progress
 * streaming; completion is reported with a background-job notification.
 */

import { spawn, execSync } from "node:child_process";
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { MAX_CONCURRENT_JOBS, type Job } from "../types.ts";
import { isBlankCommand, requireExistingCwd as requireCwd } from "../lifecycle.ts";
import { add, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import { completeJob, createJobAbort, terminateJobSilently } from "../lifecycle.ts";
import { watchStalls } from "../monitoring.ts";
import { pollFileTail } from "../output.ts";
import { textBlock } from "../format.ts";

/** Resolve the full path to the pi binary. */
function resolvePiBinary(): string {
    try {
        return execSync("which pi", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        return "pi";
    }
}

interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

/** Narrow a session entry to a message entry with content. */
function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { message: ContentMessage } {
    return entry.type === "message" && "message" in entry;
}

/** Extract text from message content; unknown blocks are ignored. */
function extractText(content: string | { type: string; text?: string }[]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

/** Latest assistant message text from the session, or "" if none. */
function lastAssistantText(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (isMessageEntry(e) && e.message.role === "assistant") {
            return extractText(e.message.content).slice(-2_000);
        }
    }
    return "";
}

/** First user prompt from the session, or "" if none. */
function firstUserPrompt(entries: SessionEntry[]): string {
    for (const e of entries) {
        if (isMessageEntry(e) && e.message.role === "user") {
            return extractText(e.message.content).slice(0, 2_000);
        }
    }
    return "";
}

/** Register the `agent_bg` tool. */
export function registerAgentBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description: "Run a separate pi -p process in the background with continuity context.",
        promptSnippet: "Delegate work to a background pi -p process",
        promptGuidelines: [
            "Use agent_bg for work that can run independently from the current session.",
            "Completion is reported with a background-job notification.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "Task to send to the background agent" }),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
        }),

        async execute(toolCallId, params, _signal, onUpdate, ctx) {
            const p = params as { prompt: string; cwd?: string };
            if (isBlankCommand(p.prompt)) throw new Error("Prompt is empty.");
            const cwd = p.cwd ?? ctx.cwd;
            requireCwd(cwd);

            const running = Array.from(reg.jobs.values()).filter((j) => j.status === "running");
            if (running.length >= MAX_CONCURRENT_JOBS) {
                throw new Error(`Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached.`);
            }

            const id = nextJobId(reg);
            const logPath = logPathFor(id);
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            // Build continuity prompt.
            const entries = ctx.sessionManager.getEntries();
            const summary = lastAssistantText(entries);
            const originalPrompt = firstUserPrompt(entries);
            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "", "## Original task", p.prompt,
                ...(originalPrompt ? ["", "## Previous user context", originalPrompt] : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "", "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${id}.md`;
            writeFileSync(promptFile, promptContent);

            const model = ctx.model;
            const modelArg = model ? `${model.provider}/${model.id}` : undefined;
            const piBin = resolvePiBinary();
            const spawnArgs = [
                "-p", "--mode", "text",
                ...(modelArg ? ["--model", modelArg] : []),
                `@${promptFile}`,
            ];

            let proc;
            try {
                proc = spawn(piBin, spawnArgs, {
                    cwd, detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            } catch (err) {
                try { unlinkSync(promptFile); } catch {}
                throw err;
            }

            if (!proc.pid) {
                try { unlinkSync(promptFile); } catch {}
                throw new Error("Failed to spawn background agent process");
            }

            const logStream = createWriteStream(logPath, { flags: "w" });
            proc.stdout?.pipe(logStream, { end: false });
            proc.stderr?.pipe(logStream, { end: false });

            const job: Job = {
                id, command: `pi -p (background agent)`, pid: proc.pid,
                startTime: Date.now(), status: "running", logPath,
                proc, toolCallId, isBackgrounded: true,
            };
            add(reg, job);

            const jobAc = createJobAbort(reg, id);

            // Progress streaming — surface agent output via onUpdate.
            const progressPoller = pollFileTail(logPath, (text) => {
                onUpdate?.({ content: [{ type: "text", text }], details: undefined });
            });
            jobAc.signal.addEventListener("abort", () => progressPoller.stop(), { once: true });

            const cancelStall = watchStalls({
                jobId: id, command: job.command, logPath, pi,
                onOversize: () => terminateJobSilently(reg, job),
            });
            jobAc.signal.addEventListener("abort", cancelStall, { once: true });

            const finalize = (code: number | null) => {
                logStream.end();
                completeJob({ job, code, reg, pi, ctx });
                try { unlinkSync(promptFile); } catch {}
            };
            proc.on("close", finalize);
            proc.on("error", () => finalize(1));

            renderSidebar(reg, ctx);
            return {
                content: [textBlock(
                    `Agent running in background with ID: ${id}. Output is being written to: ${logPath}\n` +
                    `Prompt: ${p.prompt.slice(0, 100)}${p.prompt.length > 100 ? "…" : ""}`
                )],
                details: undefined,
            };
        },
    });
}
