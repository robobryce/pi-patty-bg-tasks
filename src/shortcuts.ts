/**
 * Keyboard shortcut registration.
 *
 *   - Ctrl+B (and Ctrl+Shift+B alias): move the foreground bash to background
 *   - Ctrl+Shift+J / Shift+Down: open the background task manager
 *   - Ctrl+Shift+X: kill the most recent running job
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import {
    takeControl,
    terminateJobSilently,
    type ControlContext,
} from "./lifecycle.ts";
import { renderSidebar } from "./registry.ts";
import { jobLabel } from "./format.ts";
import { openBgListPanel } from "./ui.ts";

/** Register all shortcuts. */
export function registerShortcuts(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    if (!reg.disableCtrlBShortcut) {
        // Primary background shortcut — Ctrl+B, matching Claude Code. Inside a
        // tmux session Ctrl+B is the prefix key and must be pressed twice; the
        // live hint shown while a command runs says so.
        pi.registerShortcut("ctrl+b", {
            description: "Background the current foreground process",
            handler: async (ctx) => handleCtrlB(reg, pi, ctx),
        });
    }

    // Alias for muscle memory / terminals that remap Ctrl+B.
    pi.registerShortcut("ctrl+shift+b", {
        description: "Background the current foreground process (alias for Ctrl+B)",
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
 * Ctrl+B / Ctrl+Shift+B handler — hand control back to the agent (Claude Code
 * parity): background the running work and, if a message is queued, interrupt
 * the turn so it reaches the agent right away. See lifecycle.takeControl.
 */
async function handleCtrlB(
    reg: BackgroundRegistry,
    pi: ExtensionAPI,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>>[0]
): Promise<void> {
    takeControl(reg, pi, ctx as ControlContext);
}

/** Ctrl+Shift+X: kill the most recent running job. */
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
    ctx.ui.notify(`Killed ${jobLabel(target)}`, "info");
}
