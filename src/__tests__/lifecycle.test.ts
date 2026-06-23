/**
 * proc.ts / lifecycle.ts 단위 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree, processExists } from "../proc.ts";
import {
    createCompletionPromise,
    isSignalExit,
    markKilledSilently,
    markTerminal,
    statusFromExit,
} from "../lifecycle.ts";
import { BackgroundRegistry } from "../state.ts";
import type { Job } from "../types.ts";

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

function makeJob(): Job {
    return {
        id: "job-mt-1",
        command: "x",
        pid: 1,
        startTime: 0,
        status: "running",
        logPath: "/tmp/x",
        toolCallId: "tc-1",
        isBackgrounded: false,
    };
}

void describe("createCompletionPromise", () => {
    void it("donePromise 생성 + resolveDone로 해소 가능", async () => {
        const job = makeJob();
        createCompletionPromise(job);
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
        assert.equal(reg.agentPaused, false);
        assert.equal(reg.totalStarted, 0);
    });
});
