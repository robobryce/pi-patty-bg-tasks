/**
 * 키보드 단축키 등록.
 *
 *   - Ctrl+B: 포그라운드 bash/agent를 백그라운드로 전환 (또는 재개)
 *   - Ctrl+J / Shift+Down: 작업 목록 TUI 열기
 *   - Ctrl+X: 가장 최근 실행 중인 잡 종료
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
    pi.registerShortcut("ctrl+b", {
        description: "백그라운드 bash/agent, 또는 일시정지된 agent 재개",
        handler: async (ctx) => handleCtrlB(reg, pi, ctx),
    });

    pi.registerShortcut("ctrl+j", {
        description: "백그라운드 작업 목록 열기",
        handler: async (ctx) => showTaskList(reg, ctx),
    });

    pi.registerShortcut("shift+down", {
        description: "백그라운드 작업 목록 열기",
        handler: async (ctx) => showTaskList(reg, ctx),
    });

    pi.registerShortcut("ctrl+x", {
        description: "가장 최근 실행 중인 백그라운드 잡 종료",
        handler: async (ctx) => handleCtrlX(reg, ctx),
    });
}

/**
 * Ctrl+B 핸들러:
 *   - agentPaused면 재개한다.
 *   - 포그라운드 bash가 진행 중이면 pausePromise를 해소해 백그라운딩.
 *   - 둘 다 아니면 알림만 띄운다 (사용자에게 무의미한 상태 전이를 알리지 않음).
 */
async function handleCtrlB(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    if (reg.agentPaused) {
        reg.agentPaused = false;
        ctx.ui.setStatus("agent-paused", undefined);
        renderSidebar(reg, ctx);
        ctx.ui.notify("▶ Resumed", "info");
        pi.sendMessage(
            {
                customType: EVENT.agentResume,
                content: "Continuing where you left off.",
                display: true,
            },
            { deliverAs: "followUp", triggerTurn: true }
        );
        return;
    }

    let didBackground = false;
    if (reg.activeToolCallId) {
        const slot = reg.foreground.get(reg.activeToolCallId);
        if (slot) {
            slot.requestPause();
            didBackground = true;
        }
    }

    if (!didBackground) {
        ctx.ui.notify("No running process to background.", "warning");
        return;
    }

    reg.agentPaused = true;
    ctx.ui.setStatus("agent-paused", ctx.ui.theme.fg("warning", "⏸ Paused"));
    renderSidebar(reg, ctx);
    ctx.ui.notify("⏸ Backgrounded. Ctrl+B to resume.", "info");
}

/** Ctrl+X: 가장 최근 실행 중인 잡 종료. */
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
