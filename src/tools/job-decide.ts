/**
 * `job_decide` 툴 — 타임아웃된 백그라운드 잡에 대한 결정을 받는다.
 *
 * 결정:
 *   - keep: 계속 실행
 *   - kill: 종료
 *   - check: 현재 출력 확인
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { OUTPUT_PREVIEW_CHARS } from "../types.ts";
import { findJob, readLogTail, renderSidebar } from "../registry.ts";
import { markKilledSilently, terminateJob } from "../lifecycle.ts";
import { textBlock } from "../format.ts";

/** `job_decide` 툴을 등록한다. */
export function registerJobDecideTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerTool({
        name: "job_decide",
        label: "Job Decision",
        description: "타임아웃된 백그라운드 잡에 대해 keep / kill / check 결정.",
        promptSnippet: "타임아웃된 백그라운드 잡에 결정",
        promptGuidelines: [
            "keep: 계속 실행",
            "kill: 종료",
            "check: 현재 출력 확인",
        ],
        parameters: Type.Object({
            jobId: Type.String({ description: "결정할 잡 ID" }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description: "keep = 계속, kill = 종료, check = 출력 확인",
            }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { jobId: string; decision: "keep" | "kill" | "check" };
            const job = findJob(reg, p.jobId);
            if (!job) {
                reg.pendingDecisionJobId = undefined;
                return {
                    content: [
                        textBlock(`Job ${p.jobId} not found.`),
                    ],
                    details: undefined,
                };
            }

            switch (p.decision) {
                case "kill": {
                    if (job.status === "running") terminateJob(job);
                    markKilledSilently(job);
                    reg.pendingDecisionJobId = undefined;
                    renderSidebar(reg, ctx);
                    return {
                        content: [textBlock(`Killed ${job.name ?? job.id}.`)],
                        details: undefined,
                    };
                }
                case "keep": {
                    reg.pendingDecisionJobId = undefined;
                    return {
                        content: [
                            textBlock(
                                `Keeping ${job.name ?? job.id} running. Use jobs tool to check on it later.`
                            ),
                        ],
                        details: undefined,
                    };
                }
                case "check": {
                    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
                    return {
                        content: [
                            textBlock(`Output of ${job.name ?? job.id}:\n${out}`),
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });
}
