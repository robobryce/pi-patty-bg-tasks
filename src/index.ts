/**
 * pi-patty-bg-tasks — pi 에이전트용 백그라운드 작업 확장.
 *
 * 5개의 툴을 등록한다:
 *   - bash (오버라이드)
 *   - bash_bg
 *   - jobs
 *   - job_decide
 *   - agent_bg
 *
 * 키보드 단축키와 슬래시 커맨드도 함께 등록한다.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import { isTmuxAvailable } from "./proc.ts";
import {
    cleanupStaleRuntimeArtifacts,
    detectNonInteractive,
    reviveAndValidate,
} from "./lifecycle.ts";
import { forget as forgetJob } from "./registry.ts";
import {
    EVENT,
    PERSISTED_STATE_SCHEMA_VERSION,
    type Job,
} from "./types.ts";
import { registerBashTool } from "./tools/bash.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerJobDecideTool } from "./tools/job-decide.ts";
import { registerAgentBgTool } from "./tools/agent-bg.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";
import { registerInputHandlers } from "./input.ts";

interface PersistedState {
    schemaVersion?: number;
    jobs?: Array<[string, Omit<Job, "proc" | "donePromise" | "resolveDone">]>;
    jobCounter?: number;
}

/** 확장 진입점. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // ── 툴 등록 ───────────────────────────────────────────────────
    const originalBash = createBashTool(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerJobDecideTool(pi, reg);
    registerAgentBgTool(pi, reg);

    // ── 단축키 / 커맨드 ───────────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);


    // ── 세션 시작 ─────────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        reg.tmuxAvailable = isTmuxAvailable();
        if (!reg.tmuxAvailable && !reg.tmuxWarningShown) {
            reg.tmuxWarningShown = true;
            ctx.ui.notify(
                "⚠️ tmux not found — using direct process management",
                "warning"
            );
        }

        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // 직렬화된 백그라운드 잡 상태 복원 — 마지막 쓰기가 이김.
        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === EVENT.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        for (const entry of stateEntries) {
            const data = entry.data as PersistedState;
            if (data.jobs) {
                for (const [id, job] of data.jobs) {
                    reviveAndValidate(reg, job);
                    if (job.status !== "running") {
                        // 살아있지 않으면 즉시 카운터에 반영하고 map에서 제거.
                        forgetJob(reg, job);
                    } else {
                        reg.jobs.set(id, job);
                    }
                }
            }
            if (typeof data.jobCounter === "number") {
                reg.counter = Math.max(reg.counter, data.jobCounter);
            }
        }

        cleanupStaleRuntimeArtifacts({ tmuxAvailable: reg.tmuxAvailable });
    });

    // ── 세션 종료 ─────────────────────────────────────────────────
    pi.on("session_shutdown", async (_event, _ctx) => {
        pi.appendEntry(EVENT.state, {
            schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
            jobs: Array.from(reg.jobs.entries()).map(([id, job]) => [
                id,
                {
                    ...job,
                    proc: undefined,
                    donePromise: undefined,
                    resolveDone: undefined,
                },
            ]),
            jobCounter: reg.counter,
        });
    });
}
