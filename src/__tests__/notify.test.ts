import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import {
    enqueueFinished,
    enqueueMonitorEnd,
    flushNotices,
    noteAgentStart,
    noteAgentEnd,
    cancelPendingNotices,
} from "../notify.ts";
import { type Job, type UiContext } from "../types.ts";

interface Captured {
    customType: string;
    content: string;
    details?: { jobCount?: number; monitorCount?: number };
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

void describe("notify — turn-boundary coalescing", () => {
    void it("a single finished job reads like one line", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-5", name: "tests" }));
        flushNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        const c = messages[0].content;
        assert.match(c, /^✓ tests \(/);
        assert.match(
            c,
            /jobs\(\{ action: "output", jobId: "job-1-5" \}\)/
        );
    });

    void it("collapses a whole turn's finishes (spread out) into ONE summary at agent_end", () => {
        const { reg, pi, ctx, messages } = harness();
        noteAgentStart(reg, pi as never, ctx); // agent is mid-turn

        // Jobs finishing at different times during the turn — the old 400ms
        // window would never merge these; now they all wait for the turn end.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1", status: "completed" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2", status: "failed", exitCode: 1 }));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "API health", summary: "stream ended", failed: false });
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "port 4000", summary: "stopped (timeout)", failed: false });

        assert.equal(messages.length, 0, "nothing flushes while the agent is busy");

        noteAgentEnd(reg, pi as never, ctx);

        assert.equal(messages.length, 1, "one summary at the turn boundary");
        const c = messages[0].content;
        assert.match(c, /2 background jobs finished \(1 failed\)/);
        assert.match(c, /2 monitors ended/);
        assert.match(c, /^✓ job-1-1 \(/m);
        assert.match(c, /^✗ job-1-2 \(.*exit 1/m);
        assert.match(
            c,
            /jobs\(\{ action: "output", jobId: "job-1-1" \}\)/
        );
        assert.match(
            c,
            /jobs\(\{ action: "output", jobId: "job-1-2" \}\)/
        );
        assert.match(c, /◉ API health — stream ended/);
        assert.match(c, /◉ port 4000 — stopped \(timeout\)/);
    });

    void it("does not flush mid-turn even past the idle window", async () => {
        const { reg, pi, ctx, messages } = harness();
        noteAgentStart(reg, pi as never, ctx);
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 0, "held until the turn ends, no idle-timer flush");
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
    });

    void it("while idle, a finish flushes via the fallback timer (coalesced)", async () => {
        const { reg, pi, ctx, messages } = harness();
        // agent idle (agentBusy=false by default)
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2" }));
        assert.equal(messages.length, 0, "not flushed immediately");
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 1, "one coalesced flush after the idle window");
        const c = messages[0].content;
        assert.match(c, /2 background jobs finished/);
        // Each finished job carries its own nudge so the agent knows what to do next.
        const nudges = c.split("\n").filter((l) => /^  → jobs\(\{ action: "output"/.test(l));
        assert.equal(nudges.length, 2);
    });

    void it("noteAgentStart drains stranded notices (guard), then holds new ones for the turn", async () => {
        const { reg, pi, ctx, messages } = harness();
        // Simulate notices left pending by a prior turn that threw before agent_end.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-stranded" }));
        noteAgentStart(reg, pi as never, ctx); // drains the stranded notice up front
        assert.equal(messages.length, 1, "stranded notice flushed at turn start");

        // New finishes during this turn are held until it ends.
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-new" }));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(messages.length, 1, "new notice held for the turn");
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 2);
    });

    void it("every finished job line carries an output-read nudge", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-1" }));
        enqueueFinished(reg, pi as never, ctx, mkJob({ id: "job-1-2", status: "failed", exitCode: 2 }));
        flushNotices(reg, pi as never, ctx);
        const c = messages[0].content;
        const nudges = c.split("\n").filter((l) => /^  → jobs\(\{ action: "output"/.test(l));
        assert.equal(nudges.length, 2);
        assert.ok(nudges.some((n) => n.includes('"job-1-1"')));
        assert.ok(nudges.some((n) => n.includes('"job-1-2"')));
    });

void it("a lone monitor end reads like one line", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "deploy", summary: "stream ended", failed: false });
        flushNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 1);
        assert.match(messages[0].content, /◉ deploy — stream ended/);
    });

    void it("does not enqueue a job whose output was already consumed", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({ outputConsumed: true }));
        flushNotices(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
        assert.equal(reg.pendingFinished.length, 0);
    });

    void it("flush is a no-op when nothing is pending", () => {
        const { reg, pi, ctx, messages } = harness();
        flushNotices(reg, pi as never, ctx);
        noteAgentEnd(reg, pi as never, ctx);
        assert.equal(messages.length, 0);
    });

    void it("cancelPendingNotices drops everything without emitting", () => {
        const { reg, pi, ctx, messages } = harness();
        enqueueFinished(reg, pi as never, ctx, mkJob({}));
        enqueueMonitorEnd(reg, pi as never, ctx, { description: "x", summary: "stopped", failed: false });
        cancelPendingNotices(reg);
        assert.equal(reg.pendingFinished.length, 0);
        assert.equal(reg.pendingMonitorEnds.length, 0);
        assert.equal(reg.noticeFlushTimer, undefined);
        assert.equal(messages.length, 0);
    });
});
