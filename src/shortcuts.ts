/**
 * 키보드 단축키 등록.
 *
 *   - Ctrl+Shift+B: 포그라운드 bash/agent를 백그라운드로 전환 (또는 재개)
 *   - Ctrl+J / Shift+Down: 작업 목록 TUI 열기
 *   - Ctrl+Shift+X: 가장 최근 실행 중인 잡 종료
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { EVENT } from "./types.ts";
import { markKilledSilently, terminateJob } from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { showTaskList } from "./ui.ts";

/** 모든 단축키를 등록한다. */
export function registerShortcuts(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerShortcut("ctrl+shift+b", {
        description: "백그라운드 bash/agent, 또는 일시정지된 agent 재개",
        handler: async (ctx) => handleCtrlB(reg, pi, ctx),
    });

    pi.registerShortcut("ctrl+shift+j", {
        description: "백그라운드 작업 목록 열기",
        handler: async (ctx) => showTaskList(reg, ctx),
    });

    pi.registerShortcut("shift+down", {
        description: "백그라운드 작업 목록 열기",
        handler: async (ctx) => showTaskList(reg, ctx),
    });

    pi.registerShortcut("ctrl+shift+x", {
        description: "가장 최근 실행 중인 백그라운드 잡 종료",
        handler: async (ctx) => handleCtrlX(reg, ctx),
    });
}

/**
 * Ctrl+Shift+B 핸들러:
 *   - 포그라운드 bash가 진행 중이면 pausePromise를 해소해 백그라운딩.
 *   - 에이전트는 계속 작업한다 (pause 없음).
 */
async function handleCtrlB(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    if (reg.activeToolCallId) {
        const slot = reg.foreground.get(reg.activeToolCallId);
        if (slot) {
            slot.requestPause();
            renderSidebar(reg, ctx);
            ctx.ui.notify("◐ Backgrounded — continuing.", "info");
            // 에이전트에게 백그라운드 사실을 알린다 — 에이전트가 즉시 다음 작업을 계속할 수 있도록.
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
}

/** Ctrl+Shift+X: 가장 최근 실행 중인 잡 종료. */
async function handleCtrlX(
    reg: BackgroundRegistry,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    const running = Array.from(reg.jobs.values())
        .filter((j) => j.status === "running")
        .sort((a, b) => b.startTime - a.startTime);

    if (running.length === 0) {
        ctx.ui.notify("No running tasks to kill", "warning");
        return;
    }

    const target = running[0];
    terminateJob(target);
    markKilledSilently(target);
    renderSidebar(reg, ctx);
    ctx.ui.notify(`Killed ${target.name ?? target.id}`, "info");
}
