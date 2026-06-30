import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { takeControl, type ControlContext } from "../lifecycle.ts";
import { EVENT } from "../types.ts";

function harness(opts: { isIdle: boolean; hasPending: boolean; foreground?: boolean }) {
    const notices: { msg: string; level?: string }[] = [];
    const messages: { customType: string }[] = [];
    let paused = 0;

    const pi = { sendMessage: (m: { customType: string }) => messages.push(m) };
    const ctx = {
        ui: { notify: (msg: string, level?: string) => notices.push({ msg, level }) },
        isIdle: () => opts.isIdle,
        hasPendingMessages: () => opts.hasPending,
    } as unknown as ControlContext;

    const reg = new BackgroundRegistry();
    if (opts.foreground) {
        reg.activeToolCallId = "t1";
        reg.foreground.set("t1", {
            requestPause: () => {
                paused++;
            },
        });
    }

    return { reg, pi, ctx, notices, messages, paused: () => paused };
}

void describe("takeControl — Ctrl+B (CC-faithful, never aborts)", () => {
    void it("backgrounds a foreground command and notifies the agent", () => {
        const h = harness({ isIdle: false, hasPending: false, foreground: true });
        const outcome = takeControl(h.reg, h.pi as never, h.ctx);
        assert.equal(outcome, "backgrounded");
        assert.equal(h.paused(), 1);
        assert.equal(h.messages[0].customType, EVENT.background);
        assert.match(h.notices[0].msg, /continuing/);
    });

    void it("backgrounds the foreground command even with a queued message (queue drains at turn end)", () => {
        const h = harness({ isIdle: false, hasPending: true, foreground: true });
        const outcome = takeControl(h.reg, h.pi as never, h.ctx);
        assert.equal(outcome, "backgrounded");
        assert.equal(h.paused(), 1);
    });

    void it("sets expectations (not abort) when a message is queued but nothing is foregrounded", () => {
        const h = harness({ isIdle: false, hasPending: true, foreground: false });
        const outcome = takeControl(h.reg, h.pi as never, h.ctx);
        assert.equal(outcome, "queued");
        assert.equal(h.messages.length, 0, "does not abort or inject — would lose the message");
        assert.match(h.notices[0].msg, /current step finishes/);
    });

    void it("warns when there is nothing to background and nothing queued", () => {
        const h = harness({ isIdle: true, hasPending: false, foreground: false });
        const outcome = takeControl(h.reg, h.pi as never, h.ctx);
        assert.equal(outcome, "nothing");
        assert.equal(h.notices[0].level, "warning");
        assert.match(h.notices[0].msg, /No running process/);
    });
});
