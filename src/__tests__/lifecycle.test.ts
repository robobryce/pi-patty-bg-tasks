/**
 * proc.ts / lifecycle.ts 단위 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree, processExists } from "../proc.ts";
import {
    backgroundActiveForeground,
    ensureCompletionPromise,
    isSignalExit,
    markKilledSilently,
    markTerminal,
    notifyFinished,
    requestJobDecision,
    statusFromExit,
} from "../lifecycle.ts";
import { BackgroundRegistry } from "../state.ts";
import { EVENT, type Job, type UiContext } from "../types.ts";

void describe("processExists", () => {
    void it("현재 프로세스는 살아있다", () => {
        assert.equal(processExists(process.pid), true);
    });
    void it("PID 0은 죽은 것으로 간주", () => {
        assert.equal(processExists(0), false);
    });
    void it("음수는 죽은 것으로 간주", () => {
        assert.equal(processExists(-1), false);
    });
    void it("undefined는 죽은 것으로 간주", () => {
        assert.equal(processExists(undefined), false);
    });
});

void describe("killProcessTree", () => {
    void it("PID 0/음수/undefined는 no-op", () => {
        // throw 하지 않아야 한다.
        killProcessTree(0);
        killProcessTree(-1);
        killProcessTree(undefined);
        killProcessTree(12345678, "SIGTERM"); // 죽은 PID — throw 안 함.
    });
});

void describe("statusFromExit", () => {
    void it("0 → completed", () => {
        assert.equal(statusFromExit(0), "completed");
    });
    void it("1 → failed", () => {
        assert.equal(statusFromExit(1), "failed");
    });
    void it("null → completed (시그널 종료로 간주)", () => {
        assert.equal(statusFromExit(null), "completed");
    });
    void it("undefined → failed", () => {
        assert.equal(statusFromExit(undefined), "failed");
    });
});

void describe("isSignalExit", () => {
    void it("137 = SIGKILL", () => {
        assert.equal(isSignalExit(137), true);
    });
    void it("143 = SIGTERM", () => {
        assert.equal(isSignalExit(143), true);
    });
    void it("0은 시그널 아님", () => {
        assert.equal(isSignalExit(0), false);
    });
    void it("null은 시그널이 아님 (spawn 에러로 간주)", () => {
        assert.equal(isSignalExit(null), false);
    });
    void it("undefined는 시그널이 아님", () => {
        assert.equal(isSignalExit(undefined), false);
    });
});

void describe("markTerminal 멱등성", () => {
    void it("완료 후 재호출은 무시", () => {
        const job = makeJob();
        markTerminal(job, "completed", 0);
        markTerminal(job, "failed", 1);
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
    });
    void it("killed → killed", () => {
        const job = makeJob();
        markTerminal(job, "killed");
        assert.equal(job.status, "killed");
    });
});

function makeJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-mt-1",
        command: "x",
        pid: 1,
        startTime: 0,
        status: "running",
        logPath: "/tmp/x",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("ensureCompletionPromise", () => {
    void it("donePromise 생성 + resolveDone로 해소 가능", async () => {
        const job = makeJob();
        ensureCompletionPromise(job);
        assert.ok(job.donePromise);
        assert.ok(job.resolveDone);
        let resolved = false;
        void job.donePromise.then(() => {
            resolved = true;
        });
        job.resolveDone!();
        await job.donePromise;
        assert.equal(resolved, true);
    });
});

void describe("markKilledSilently", () => {
    void it("status=killed, outputConsumed=true", () => {
        const job = makeJob();
        markKilledSilently(job);
        assert.equal(job.status, "killed");
        assert.equal(job.outputConsumed, true);
    });
});

void describe("BackgroundRegistry 기본", () => {
    void it("기본 필드 초기화", () => {
        const reg = new BackgroundRegistry();
        assert.ok(reg.jobs instanceof Map);
        assert.ok(reg.foreground instanceof Map);
        assert.equal(reg.counter, 0);
        assert.equal(reg.activeToolCallId, null);
        assert.equal(reg.totalStarted, 0);
    });
});

void describe("backgroundActiveForeground", () => {
    void it("manual background sends bg-manual without creating a timeout decision", () => {
        const reg = new BackgroundRegistry();
        const sent: { customType?: string }[] = [];
        const notifications: string[] = [];
        let pauseReason: string | undefined;
        reg.activeToolCallId = "tc-manual";
        reg.foreground.set("tc-manual", {
            toolCallId: "tc-manual",
            proc: { pid: -1 } as never,
            command: "python long.py",
            logPath: "/tmp/manual.log",
            requestPause: (reason) => {
                pauseReason = reason;
            },
        });

        const ok = backgroundActiveForeground(
            reg,
            { sendMessage: (msg: { customType?: string }) => sent.push(msg) } as never,
            makeCtx(notifications)
        );

        assert.equal(ok, true);
        assert.equal(pauseReason, "manual");
        assert.equal(reg.pendingDecisionJobId, undefined);
        assert.equal(sent[0]?.customType, EVENT.background);
        assert.equal(notifications[0], "▶ Backgrounded — continuing.");
    });
});

void describe("requestJobDecision", () => {
    void it("timeout background records pending decision and uses lightweight notification", () => {
        const reg = new BackgroundRegistry();
        const notifications: string[] = [];
        const job = makeJob({ id: "job-timeout", command: "pnpm test" });

        requestJobDecision({
            reg,
            ctx: makeCtx(notifications),
            job,
            timeoutMs: 15_000,
        });

        assert.equal(reg.pendingDecisionJobId, "job-timeout");
        assert.equal(notifications[0], "Backgrounded job-timeout after 15s; still running.");
    });
});

void describe("notifyFinished", () => {
    void it("uses lightweight UI notification instead of boxed job-finished custom message", () => {
        const reg = new BackgroundRegistry();
        const notifications: string[] = [];
        const sent: unknown[] = [];
        const job = makeJob({
            id: "job-done",
            command: "pnpm test",
            startTime: Date.now(),
            status: "completed",
            exitCode: 0,
        });

        notifyFinished({
            job,
            reg,
            pi: {
                sendMessage: (...args: unknown[]) => sent.push(args),
            } as never,
            ctx: makeCtx(notifications),
        });

        assert.deepEqual(sent, []);
        assert.equal(notifications[0], 'Background bash "pnpm test" completed (0s)\nExit code: 0');
    });
});

function makeCtx(notifications: string[] = []): UiContext {
    return {
        ui: {
            notify: (message) => notifications.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour, text) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
    };
}
