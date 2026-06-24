import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerInputHandlers } from "../input.ts";
import { BackgroundRegistry } from "../state.ts";
import { EVENT, type UiContext } from "../types.ts";

type InputHandler = (
    event: {
        type: "input";
        text: string;
        source: "interactive" | "rpc" | "extension";
        streamingBehavior?: "steer" | "followUp";
    },
    ctx: UiContext & {
        abort(): void;
        isIdle(): boolean;
        signal?: AbortSignal;
    }
) => Promise<
    | { action: "continue" }
    | { action: "transform"; text: string }
    | { action: "handled" }
>;

void describe("input steering (cooperative scheduler)", () => {
    void it("auto-backgrounds, aborts the turn, returns handled, and resubmits via sendUserMessage", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const userMessages: string[] = [];
        const notifications: string[] = [];
        let pauseReason: string | undefined;
        let abortCalled = false;
        let idle = false;
        const handler = registerAndGetHandler(reg, sent, userMessages, {
            abort: () => {
                abortCalled = true;
            },
            isIdle: () => idle,
        });
        reg.activeToolCallId = "tc-steer";
        reg.foreground.set("tc-steer", {
            toolCallId: "tc-steer",
            proc: { pid: -1 } as never,
            command: "pnpm test",
            logPath: "/tmp/steer.log",
            requestPause: (reason) => {
                pauseReason = reason;
            },
        });

        const resultP = handler(
            {
                type: "input",
                text: "stop and inspect the last failure",
                source: "interactive",
                streamingBehavior: "steer",
            },
            makeCtx(notifications, { abort: () => { abortCalled = true; }, isIdle: () => idle })
        );

        const result = await resultP;

        assert.equal(result.action, "handled");
        assert.equal(pauseReason, "manual");
        assert.equal(abortCalled, true);
        assert.equal(sent[0]?.customType, EVENT.background);

        idle = true;
        await waitForResubmit(() => userMessages.length > 0, 50);
        assert.deepEqual(userMessages, ["stop and inspect the last failure"]);
    });

    void it("second steer while still active does not double-background or double-resubmit", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const userMessages: string[] = [];
        const notifications: string[] = [];
        let abortCalls = 0;
        let idle = false;
        const handler = registerAndGetHandler(reg, sent, userMessages, {
            abort: () => { abortCalls++; },
            isIdle: () => idle,
        });
        reg.activeToolCallId = "tc-steer2";
        reg.foreground.set("tc-steer2", {
            toolCallId: "tc-steer2",
            proc: { pid: -1 } as never,
            command: "pnpm test",
            logPath: "/tmp/steer2.log",
            requestPause: () => {},
        });

        const r1 = await handler(
            { type: "input", text: "first", source: "interactive", streamingBehavior: "steer" },
            makeCtx(notifications, { abort: () => { abortCalls++; }, isIdle: () => idle })
        );
        const r2 = await handler(
            { type: "input", text: "second", source: "interactive", streamingBehavior: "steer" },
            makeCtx(notifications, { abort: () => { abortCalls++; }, isIdle: () => idle })
        );

        assert.equal(r1.action, "handled");
        assert.equal(r2.action, "continue");
        assert.equal(sent.length, 1);
        assert.equal(abortCalls, 1);

        idle = true;
        await waitForResubmit(() => userMessages.length > 0, 50);
        assert.deepEqual(userMessages, ["first"]);
    });

    void it("returns continue (no interrupt) for non-steer input", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const userMessages: string[] = [];
        let pauseReason: string | undefined;
        const handler = registerAndGetHandler(reg, sent, userMessages);
        reg.activeToolCallId = "tc-follow-up";
        reg.foreground.set("tc-follow-up", {
            toolCallId: "tc-follow-up",
            proc: { pid: -1 } as never,
            command: "pnpm test",
            logPath: "/tmp/follow-up.log",
            requestPause: (reason) => { pauseReason = reason; },
        });

        const result = await handler(
            { type: "input", text: "check this after you finish", source: "interactive", streamingBehavior: "followUp" },
            makeCtx([], { abort: () => {}, isIdle: () => true })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(pauseReason, undefined);
        assert.equal(sent.length, 0);
        assert.equal(userMessages.length, 0);
    });

    void it("returns continue when no cooperative foreground task is active", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const userMessages: string[] = [];
        const handler = registerAndGetHandler(reg, sent, userMessages);
        reg.activeToolCallId = null;

        const result = await handler(
            { type: "input", text: "any steering", source: "interactive", streamingBehavior: "steer" },
            makeCtx([], { abort: () => {}, isIdle: () => true })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(sent.length, 0);
        assert.equal(userMessages.length, 0);
    });

    void it("ignores extension-sourced input (recursion guard)", async () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const userMessages: string[] = [];
        const handler = registerAndGetHandler(reg, sent, userMessages);
        reg.activeToolCallId = "tc-ext";
        reg.foreground.set("tc-ext", {
            toolCallId: "tc-ext",
            proc: { pid: -1 } as never,
            command: "pnpm test",
            logPath: "/tmp/ext.log",
            requestPause: () => {},
        });

        const result = await handler(
            { type: "input", text: "self-resubmit", source: "extension", streamingBehavior: "steer" },
            makeCtx([], { abort: () => {}, isIdle: () => true })
        );

        assert.deepEqual(result, { action: "continue" });
        assert.equal(sent.length, 0);
        assert.equal(userMessages.length, 0);
    });
});

function registerAndGetHandler(
    reg: BackgroundRegistry,
    sent: { customType?: string }[],
    userMessages: string[],
    _ctxActions?: { abort(): void; isIdle(): boolean }
): InputHandler {
    let handler: InputHandler | undefined;
    registerInputHandlers(
        {
            on(event: string, fn: InputHandler) {
                if (event === "input") handler = fn;
            },
            sendMessage(message: { customType?: string }) {
                sent.push(message);
            },
            sendUserMessage(content: string | object[]) {
                if (typeof content === "string") userMessages.push(content);
            },
        } as never,
        reg
    );
    assert.ok(handler);
    return handler;
}

function makeCtx(
    notifications: string[] = [],
    actions?: { abort(): void; isIdle(): boolean }
): UiContext & { abort(): void; isIdle(): boolean } {
    return {
        ui: {
            notify: (message) => notifications.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour, text) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
        abort: actions?.abort ?? (() => {}),
        isIdle: actions?.isIdle ?? (() => true),
    };
}

function waitForResubmit(pred: () => boolean, intervalMs = 10, timeoutMs = 500): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error("resubmit timeout"));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}
