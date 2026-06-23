/**
 * 포맷 헬퍼 단위 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatDuration,
    formatJobLine,
    statusLabel,
    truncateTail,
} from "../format.ts";
import type { Job } from "../types.ts";

function makeJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "job-test-1",
        command: "echo",
        pid: 1,
        startTime: Date.now(),
        status: "completed",
        logPath: "/tmp/test",
        toolCallId: "tc-1",
        isBackgrounded: false,
        ...overrides,
    };
}

void describe("formatDuration", () => {
    void it("0초 미만은 0s", () => {
        assert.equal(formatDuration(0), "0s");
        assert.equal(formatDuration(999), "0s");
    });
    void it("초 단위만", () => {
        assert.equal(formatDuration(1_000), "1s");
        assert.equal(formatDuration(45_000), "45s");
    });
    void it("분 + 초", () => {
        assert.equal(formatDuration(60_000), "1m0s");
        assert.equal(formatDuration(125_000), "2m5s");
        assert.equal(formatDuration(3_600_000), "60m0s");
    });
});

void describe("truncateTail", () => {
    void it("maxChars 이하면 그대로", () => {
        assert.equal(truncateTail("short", 100), "short");
    });
    void it("maxChars 초과면 마커 + 꼬리", () => {
        const out = truncateTail("x".repeat(200), 50);
        assert.match(out, /\.\.\.\[truncated, showing last 50 chars\]/);
        assert.ok(out.endsWith("x".repeat(50)));
    });
});

void describe("statusLabel", () => {
    void it("running + backgrounded", () => {
        assert.equal(
            statusLabel(makeJob({ status: "running", isBackgrounded: true })),
            "▶ running (0s)"
        );
    });
    void it("running + foreground", () => {
        assert.equal(
            statusLabel(makeJob({ status: "running", isBackgrounded: false })),
            "▶ running (0s)"
        );
    });
    void it("completed", () => {
        assert.equal(statusLabel(makeJob({ status: "completed" })), "✓ completed");
    });
    void it("failed", () => {
        assert.equal(statusLabel(makeJob({ status: "failed" })), "✗ failed");
    });
    void it("killed", () => {
        assert.equal(statusLabel(makeJob({ status: "killed" })), "✗ killed");
    });
});

void describe("formatJobLine", () => {
    void it("running 잡은 duration 표시", () => {
        const job: Job = {
            id: "job-1-1",
            command: "sleep 60",
            pid: 1,
            startTime: Date.now() - 5_000,
            status: "running",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
            isBackgrounded: true,
        };
        assert.match(formatJobLine(job), /^job-1-1: sleep 60 - ▶ running \(5s\) \(5s\)$/);
    });
    void it("이름 있는 잡은 이름 우선", () => {
        const job: Job = {
            id: "job-1-2",
            name: "build",
            command: "ls",
            pid: 1,
            startTime: Date.now(),
            status: "completed",
            logPath: "/tmp/test",
            toolCallId: "tc-1",
            isBackgrounded: false,
        };
        assert.match(formatJobLine(job), /^build \(job-1-2\):/);
    });
});
