/**
 * pi-patty-bg-tasks — background task extension for the pi agent.
 *
 * Registers five tools:
 *   - bash (override)
 *   - bash_bg
 *   - jobs
 *   - job_decide
 *   - agent_bg
 *
 * Also registers keyboard shortcuts and slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import {
    cleanupStaleRuntimeArtifacts,
    detectNonInteractive,
    reviveAndValidate,
    terminateJobSilently,
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

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    // ── Tool registration ─────────────────────────────────────────
    const originalBash = createBashTool(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerJobDecideTool(pi, reg);
    registerAgentBgTool(pi, reg);

    // ── Shortcuts / commands ──────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Restore serialized background job state.
        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === EVENT.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        for (const entry of stateEntries) {
            const data = entry.data as PersistedState;
            if (data.schemaVersion !== PERSISTED_STATE_SCHEMA_VERSION) continue;
            if (data.jobs) {
                for (const [id, job] of data.jobs) {
                    reviveAndValidate(reg, job);
                    if (job.status !== "running") {
                        // Not alive — fold into the counter and drop from the map.
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

        cleanupStaleRuntimeArtifacts();
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async (event, _ctx) => {
        // On quit, kill all running background jobs to avoid orphans.
        if (event.reason === "quit") {
            for (const job of reg.jobs.values()) {
                if (job.status === "running") {
                    terminateJobSilently(reg, job);
                }
            }
        }

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
