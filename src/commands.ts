/**
 * 슬래시 커맨드 등록.
 *
 *   - /bg: Ctrl+Shift+B와 동일
 *   - /fg [job-id] [--snapshot]: 잡 출력 attach
 *   - /jobs: 작업 목록 TUI 열기
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { EVENT, OUTPUT_PREVIEW_CHARS } from "./types.ts";
import { createCompletionPromise, markKilledSilently, terminateJob } from "./lifecycle.ts";
import { findJob, readLogTail, renderSidebar } from "./registry.ts";
import { showTaskList } from "./ui.ts";

/** 모든 슬래시 커맨드를 등록한다. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg", {
        description: "백그라운드 bash/agent, 또는 일시정지된 agent 재개",
        handler: async (_args, ctx) => {
            // 단순 alias: Ctrl+Shift+B 핸들러 호출.
            if (reg.activeToolCallId) {
                const slot = reg.foreground.get(reg.activeToolCallId);
                if (slot) {
                    slot.requestPause();
                    renderSidebar(reg, ctx);
                    ctx.ui.notify("◐ Backgrounded — continuing.", "info");
                    pi.sendMessage(
                        {
                            customType: EVENT.background,
                            content:
                                `Command was manually backgrounded by user. ` +
                                `It is still running and output is being captured. ` +
                                `You can continue working on other tasks. ` +
                                `Use the jobs tool to check on it later.`,
                            display: true,
                        },
                        { deliverAs: "followUp", triggerTurn: true }
                    );
                    return;
                }
            }
            ctx.ui.notify("No running process to background.", "warning");
        },
    });

    pi.registerCommand("fg", {
        description: "/fg [job-id] [--snapshot]: 잡 출력 attach (기본: 가장 최근 실행 중)",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const snapshot = parts.includes("--snapshot") || parts.includes("-s");
            const explicitId = parts.find((p) => !p.startsWith("-"));

            let job = explicitId
                ? findJob(reg, explicitId)
                : Array.from(reg.jobs.values())
                      .filter((j) => j.status === "running")
                      .sort((a, b) => b.startTime - a.startTime)[0];

            if (!job) {
                ctx.ui.notify(
                    explicitId
                        ? `Job not found: ${explicitId}`
                        : "No running background jobs. Usage: /fg [job-id] [--snapshot]",
                    "warning"
                );
                return;
            }

            ctx.ui.setStatus(
                "attach-flow",
                `Attaching to ${job.name ?? job.id}${snapshot ? " (snapshot)" : ""}...`
            );
            try {
                if (!snapshot && job.status === "running") {
                    createCompletionPromise(job);
                    await job.donePromise;
                }

                const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
                const text =
                    `Job: ${job.name ?? job.id}\nCommand: ${job.command}\nStatus: ${job.status}\n` +
                    `PID: ${job.pid}\nStarted: ${new Date(job.startTime).toLocaleString()}\n` +
                    `Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`;

                pi.sendMessage(
                    {
                        customType: EVENT.attach,
                        content: text,
                        display: true,
                        details: { jobId: job.id, logPath: job.logPath },
                    },
                    { deliverAs: "steer", triggerTurn: false }
                );
                ctx.ui.notify(
                    `Attached output posted for ${job.name ?? job.id}`,
                    "info"
                );
            } finally {
                ctx.ui.setStatus("attach-flow", undefined);
            }
        },
    });

    pi.registerCommand("jobs", {
        description: "백그라운드 작업 관리 UI 열기",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await showTaskList(reg, ctx);
        },
    });
}
