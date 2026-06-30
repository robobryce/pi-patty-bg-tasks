import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";
import { processExists, killProcessTree } from "../spawn.ts";
import type { Job } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolDef {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<unknown>;
}

function harness() {
    let tool: ToolDef | undefined;
    const pi = {
        registerTool: (def: ToolDef) => {
            tool = def;
        },
        sendMessage: () => {},
    };
    const reg = new BackgroundRegistry();
    // The override supplies name/params/execute; the original def is only spread
    // for renderers, so an empty stub is enough here.
    registerBashTool(pi as never, reg, {} as never);
    const ctx = {
        cwd: process.cwd(),
        ui: {
            notify: () => {},
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
        },
    };
    return { tool: tool!, reg, ctx };
}

void describe("bash foreground — survives a turn abort (no data loss)", () => {
    const spawnedPids: number[] = [];

    void it("backgrounds the command instead of killing it when the turn aborts", async () => {
        const { tool, reg, ctx } = harness();
        const ac = new AbortController();

        // Long-running command; don't await — it resolves once backgrounded.
        void tool.execute("t1", { command: "tail -f /dev/null" }, ac.signal, undefined, ctx);
        await sleep(400); // let it spawn + register the foreground job

        const job = [...reg.jobs.values()][0] as Job;
        assert.ok(job, "a foreground job was registered");
        const pid = job.pid;
        spawnedPids.push(pid);
        assert.ok(processExists(pid), "process is running before the abort");
        assert.equal(job.isBackgrounded, false, "still foreground before the abort");

        // The turn aborts (implicit timeout / Esc).
        ac.abort();
        await sleep(150);

        assert.ok(
            processExists(pid),
            "process MUST still be alive — a turn abort must not kill it"
        );
        assert.equal(job.isBackgrounded, true, "command survived as a background job");
        assert.equal(job.status, "running", "background job is still running");
    });

    after(() => {
        for (const pid of spawnedPids) {
            try {
                killProcessTree(pid, "SIGKILL");
            } catch {
                /* already gone */
            }
        }
    });
});
