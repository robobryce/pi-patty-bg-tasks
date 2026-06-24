/**
 * 키보드 단축키 등록.
 *
 *   - Ctrl+Shift+B: 포그라운드 bash/agent를 백그라운드로 전환 (또는 재개)
 *   - Ctrl+J / Shift+Down: 작업 목록 TUI 열기
 *   - Ctrl+Shift+X: 가장 최근 실행 중인 잡 종료
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import {
    backgroundActiveForeground,
    terminateJobSilently,
} from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { openBgListPanel } from "./ui.ts";

/** 모든 단축키를 등록한다. */
export function registerShortcuts(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerShortcut("ctrl+shift+b", {
        description: "Background the current foreground process",
        handler: async (ctx) => handleCtrlB(reg, pi, ctx),
    });

    pi.registerShortcut("ctrl+shift+j", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("shift+down", {
        description: "Open background task manager",
        handler: async (ctx) => openBgListPanel(reg, ctx),
    });

    pi.registerShortcut("ctrl+shift+x", {
        description: "Kill the most recent running background job",
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
    if (backgroundActiveForeground(reg, pi, ctx)) return;
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
    terminateJobSilently(reg, target);
    renderSidebar(reg, ctx);
    ctx.ui.notify(`Killed ${target.name ?? target.id}`, "info");
}
