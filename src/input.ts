import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

/** Bounded wait for the aborted turn to settle before resubmitting. */
const IDLE_POLL_MS = 20;
const IDLE_TIMEOUT_MS = 5_000;

/** Fallback resubmit window — if the turn never settles, queue as followUp. */
const RESUBMIT_FALLBACK_DELAY_MS = 2_000;

type InterruptCtx = UiContext & {
    abort?(): void;
    isIdle?(): boolean;
};

export function registerInputHandlers(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.on("input", async (event, ctx) => {
        if (event.streamingBehavior !== "steer") return { action: "continue" };
        if (event.source === "extension") return { action: "continue" };
        if (!reg.activeToolCallId) return { action: "continue" };
        if (!reg.foreground.has(reg.activeToolCallId)) {
            return { action: "continue" };
        }

        const text = event.text;
        const ictx = ctx as InterruptCtx;
        const bg = backgroundActiveForeground(reg, pi, ictx as UiContext);
        if (!bg) return { action: "continue" };

        ictx.abort?.();

        void resubmitAfterIdle(pi, ictx, text);

        return { action: "handled" };
    });
}

async function resubmitAfterIdle(
    pi: ExtensionAPI,
    ctx: InterruptCtx,
    text: string
): Promise<void> {
    const isIdle = ctx.isIdle ?? (() => true);
    const start = Date.now();
    while (!isIdle()) {
        if (Date.now() - start > IDLE_TIMEOUT_MS) {
            setTimeout(() => {
                try {
                    pi.sendUserMessage(text, { deliverAs: "followUp" });
                } catch {
                    /* turn gone — nothing to deliver to */
                }
            }, RESUBMIT_FALLBACK_DELAY_MS);
            return;
        }
        await sleep(IDLE_POLL_MS);
    }
    try {
        pi.sendUserMessage(text);
    } catch {
        /* session ended between abort and resubmit */
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
