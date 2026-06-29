// src/proc.ts — re-export shim for process primitives (tmux removed).
export { spawnWithFileOutput, killProcessTree, processExists } from "./spawn.ts";
