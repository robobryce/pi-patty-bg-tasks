// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Only intercept when we have an active foreground command.
        if (!reg.activeToolCallId) return { action: "continue" };
        if (!reg.foreground.has(reg.activeToolCallId)) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, pi, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // Abort the current turn so the bash tool returns the "backgrounded" result.
        ctx.abort?.();

        // Resubmit the user's message as a follow-up — Pi delivers it
        // after the current turn settles. No polling needed.
        try {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
        } catch {
            // Session ended between abort and resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
