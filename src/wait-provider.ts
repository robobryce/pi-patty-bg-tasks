/**
 * Register pi-patty-bg-tasks as a background-work provider for a `wait` tool.
 *
 * A `wait` tool (e.g. pi-subagents') blocks the current turn until outstanding
 * background work finishes. It discovers work through a process-global provider
 * registry: any extension can publish a provider exposing how many of its units
 * are in flight (`liveCount`) and which bus channels signal a state change
 * (`wakeChannels`). This is dependency-free — no import between the packages,
 * just a shared global keyed by a stable, versioned symbol — so patty declares
 * the shape inline rather than importing it.
 *
 * We reuse patty's own liveness source (shared-live.ts' liveJobCount) and its
 * job-finished bus channel, so `wait` sees exactly the jobs the sidebar does and
 * wakes the instant one completes.
 */

import { liveJobCount } from "./shared-live.ts";
import { BG_TASK_FINISHED_EVENT } from "./types.ts";
import { reconcileJobs } from "./reconcile.ts";
import type { BackgroundRegistry } from "./state.ts";

/** Must match pi-subagents/src/runs/background/bg-providers.ts. */
const REGISTRY_KEY = "__pi_bg_work_providers_v1";

interface BackgroundWorkProvider {
    name: string;
    liveCount(): number;
    wakeChannels?: readonly string[];
    reconcile?(nowMs: number): void;
}

function registry(): Map<string, BackgroundWorkProvider> {
    const g = globalThis as Record<string, unknown>;
    let reg = g[REGISTRY_KEY] as Map<string, BackgroundWorkProvider> | undefined;
    if (!(reg instanceof Map)) {
        reg = new Map<string, BackgroundWorkProvider>();
        g[REGISTRY_KEY] = reg;
    }
    return reg;
}

/**
 * Publish patty's provider on the shared registry. Idempotent (keyed by name).
 * Returns an unregister function. Safe to call even if no `wait` tool is
 * installed — the registry is just a global map nobody reads until one is.
 *
 * The provider also supplies a `reconcile()` health check (see reconcile.ts):
 * on each of wait's poll ticks it finalizes jobs whose process has died and
 * kills jobs that are alive but wedged (no output past a stale window), so a
 * `wait` tool never blocks forever on a background job that will never finish.
 */
export function registerWaitProvider(reg: BackgroundRegistry): () => void {
    const provider: BackgroundWorkProvider = {
        name: "pi-patty-bg-tasks",
        liveCount: () => liveJobCount(),
        wakeChannels: [BG_TASK_FINISHED_EVENT],
        reconcile: (nowMs: number) => reconcileJobs(reg, { now: () => nowMs }),
    };
    const store = registry();
    store.set(provider.name, provider);
    return () => {
        if (store.get(provider.name) === provider) store.delete(provider.name);
    };
}
