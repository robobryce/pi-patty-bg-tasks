import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { registerBashTool } from "../tools/bash.ts";

function makeCtx(outputs: string[] = []) {
    return {
        cwd: process.cwd(),
        ui: {
            notify: (message: string) => outputs.push(message),
            setWidget: () => {},
            setStatus: () => {},
            theme: { fg: (_colour: string, text: string) => text },
            select: async () => undefined,
            editor: async () => undefined,
        },
    };
}

void describe("bash override", () => {
    void it("does not crash when a direct foreground command exceeds the quick-completion window", async () => {
        const reg = new BackgroundRegistry();
        reg.tmuxAvailable = false;
        reg.nonInteractive = true;

        let bashTool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> } | undefined;
        const pi = {
            registerTool(tool: typeof bashTool) {
                bashTool = tool;
            },
        };
        const originalBash = {
            name: "bash",
            description: "original bash",
            parameters: {},
        };

        registerBashTool(pi as never, reg, originalBash as never);

        assert.ok(bashTool);
        const result = await bashTool.execute(
            "tc-long-direct",
            { command: "node -e \"setTimeout(() => console.log('done'), 2100)\"" },
            undefined,
            undefined,
            makeCtx()
        );

        assert.match(result.content[0]?.text ?? "", /done/);
    });
});
