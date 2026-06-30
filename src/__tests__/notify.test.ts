import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { enqueueFinished, flushFinished, cancelFinishedFlush } from "../notify.ts";
import { type Job, type UiContext } from "../types.ts";

interface Captured {
    customType: string;
    content: string;
    details?: { count?: number; jobs?: unknown[] };
}

function harness() {
    const messages: Captured[] = [];
    const notices: { content: string; level?: string }[] = [];
    const pi = { sendMessage: (m: Captured) => messages.push(m) };
    const ctx = {
        ui: {
            notify: (content: string, level?: string) => {
                notices.push({ content, level });
            },
        },
    } as unknown as UiContext;
    return { reg: new BackgroundRegistry(), pi, ctx, messages, notices };
}

function mkJob(over: Partial<Job>): Job {
    return {
        id: "job-1-1",
        command: "npm test",
        pid: 100,
        startTime: Date.now(),
        status: "completed",
        logPath: "/tmp/pi-bg/job-1-1.log",
        toolCallId: "t",
        isBackgrounded: true,
        ...over,
    } as Job;
}

void describe("notify — completion coalescing", () => {
    void it("a single finished job reads like one line", () => {
        const { reg, pi, ctx, messages, notices } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-5", name: "tests" }));
        flushFinished(reg, pi as never, ctx);

        assert.equal(messages.length, 1);
        assert.match(messages[0].content, /Background bash "tests" completed/);
        assert.match(messages[0].content, /job-1-5/);
        assert.equal(notices[0].level, "info");
        assert.equal(reg.pendingFinished.length, 0);
    });

    void it("a burst collapses into ONE grouped summary, not a wall", () => {
        const { reg, pi, ctx, messages, notices } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "completed" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2", status: "completed" }));
        enqueueFinished(
            reg,
            pi as never,
            ctx,
            mkJob({ id: "job-1-3", status: "failed", exitCode: 1 })
        );
        flushFinished(reg, pi as never, ctx);

        assert.equal(messages.length, 1, "burst must collapse to one message");
        const c = messages[0].content;
        assert.match(c, /3 background jobs finished/);
        assert.match(c, /2 completed \(job-1-1, job-1-2\)/);
        assert.match(c, /1 failed \(job-1-3 exit 1\)/);
        assert.equal(messages[0].details?.count, 3);
        assert.equal(notices[0].level, "error", "any failure makes the notice an error");
    });

    void it("opens the window once for a burst (no per-job timer churn)", () => {
        const { reg, pi, ctx } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        const firstTimer = reg.finishedFlushTimer;
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2" }));
        assert.equal(reg.finishedFlushTimer, firstTimer, "second job reuses the open window");
        assert.equal(reg.pendingFinished.length, 2);
    });

    void it("does not enqueue a job whose output was already consumed", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ outputConsumed: true }));
        assert.equal(reg.pendingFinished.length, 0);
        flushFinished(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
    });

    void it("flush is a no-op when nothing is pending", () => {
        const { reg, pi, ctx, messages } = harness();
        flushFinished(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
    });

    void it("cancelFinishedFlush drops the window without emitting", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        cancelFinishedFlush(reg);
        assert.equal(reg.pendingFinished.length, 0);
        assert.equal(reg.finishedFlushTimer, undefined);
        assert.equal(messages.length, 0);
    });

    void it("auto-flushes after the coalescing window", async () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-9" }));
        assert.equal(messages.length, 0, "not flushed immediately");
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 1, "flushed after the window");
        assert.equal(reg.finishedFlushTimer, undefined);
    });
});
