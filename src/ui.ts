/**
 * UI 헬퍼 — TUI 작업 목록과 잡 상세 화면.
 */

import type { Job, UiContext } from "./types.ts";
import { PREVIEW_CHARS } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration } from "./format.ts";
import {
    createCompletionPromise,
    markKilledSilently,
    markTerminal,
    terminateJob,
} from "./lifecycle.ts";
import { OUTPUT_PREVIEW_CHARS } from "./types.ts";
import {
    processExists,
} from "./proc.ts";
import {
    findJob,
    forget,
    readLogTail,
    renderSidebar,
} from "./registry.ts";

/** 잡 상세 화면 — Attach / Show Output / Kill 액션 선택. */
export async function showTaskDetail(
    job: Job,
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    const duration = formatDuration(Date.now() - job.startTime);
    const icon = iconFor(job);

    if (job.status === "running") {
        const choice = await ctx.ui.select(
            `${icon} ${job.name ?? job.id} · ${job.command.slice(0, PREVIEW_CHARS.detail)} · ${duration}`,
            ["Attach (wait for completion)", "Show Output", "Kill"]
        );
        if (choice === undefined) return;
        if (choice.startsWith("Attach")) {
            ctx.ui.setStatus("attach-flow", `Attaching to ${job.name ?? job.id}...`);
            createCompletionPromise(job);
            await job.donePromise;
            ctx.ui.setStatus("attach-flow", undefined);
            const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
            await ctx.ui.editor(
                `${icon} ${job.name ?? job.id}: ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
                `Command: ${job.command}\n` +
                    `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Duration: ${duration} · Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
            );
        } else if (choice.startsWith("Show Output")) {
            const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
            await ctx.ui.editor(
                `${icon} ${job.name ?? job.id}: ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
                `Command: ${job.command}\n` +
                    `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Duration: ${duration} · Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
            );
        } else {
            terminateJob(job);
            markKilledSilently(job);
            if (reg.pendingDecisionJobId === job.id) {
                reg.pendingDecisionJobId = undefined;
            }
            renderSidebar(reg, ctx);
            ctx.ui.notify(`Killed ${job.name ?? job.id}`, "info");
        }
    } else {
        const choice = await ctx.ui.select(
            `${icon} ${job.name ?? job.id} · ${job.command.slice(0, PREVIEW_CHARS.detail)} · ${job.status}`,
            ["Show Output", "Remove from List"]
        );
        if (choice === undefined) return;
        if (choice.startsWith("Show Output")) {
            const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
            await ctx.ui.editor(
                `${icon} ${job.name ?? job.id}: ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
                `Command: ${job.command}\n` +
                    `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Status: ${job.status} · Exit code: ${job.exitCode ?? "n/a"}\n` +
                    `Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
            );
        } else {
            forget(reg, job);
            renderSidebar(reg, ctx);
            ctx.ui.notify(`Removed ${job.name ?? job.id}`, "info");
        }
    }
}

/** TUI: 모든 작업을 보여주고 선택된 항목의 상세로 들어간다. */
export async function showTaskList(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    const allJobs = Array.from(reg.jobs.values());
    const runningJobs = allJobs.filter((j) => j.status === "running");
    const finishedJobs = allJobs.filter((j) => j.status !== "running");

    const items: string[] = [];
    if (reg.agentPaused) {
        items.push("◐ agent · paused · Ctrl+B to resume");
    }
    for (const job of runningJobs) {
        const duration = formatDuration(Date.now() - job.startTime);
        const label = job.name ? `${job.name} (${job.id})` : job.id;
        items.push(`◐ ${label}: ${job.command.slice(0, PREVIEW_CHARS.taskList)} · ${duration}`);
    }
    for (const job of finishedJobs) {
        const label = job.name ? `${job.name} (${job.id})` : job.id;
        items.push(`${iconFor(job)} ${label}: ${job.command.slice(0, PREVIEW_CHARS.taskList)}`);
    }

    if (items.length === 0) {
        ctx.ui.notify("No background tasks", "info");
        return;
    }

    const choice = await ctx.ui.select("Background Tasks", items);
    if (choice === undefined) return;

    if (reg.agentPaused && choice === items[0]) {
        resumeAgent(reg, ctx);
        return;
    }

    const selected = [...runningJobs, ...finishedJobs].find((j) =>
        choice?.includes(j.name ? `${j.name} (${j.id})` : j.id)
    );
    if (selected) await showTaskDetail(selected, reg, ctx);
}

/** Ctrl+B의 두 번째 동작: agentPaused 해제 + 통지. */
function resumeAgent(reg: BackgroundRegistry, ctx: UiContext): void {
    reg.agentPaused = false;
    ctx.ui.setStatus("agent-paused", undefined);
    renderSidebar(reg, ctx);
    ctx.ui.notify("▶ Resumed", "info");
}

function iconFor(job: Job): string {
    switch (job.status) {
        case "running":
            return "◐";
        case "completed":
            return "✅";
        case "failed":
            return "❌";
        case "killed":
            return "🛑";
    }
}

void findJob;
void processExists;
void markTerminal;
