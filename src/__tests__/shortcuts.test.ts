import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerShortcuts } from "../shortcuts.ts";
import { BackgroundRegistry } from "../state.ts";

function registeredShortcuts(disableCtrlBShortcut: boolean): string[] {
    const shortcuts: string[] = [];
    const pi = {
        registerShortcut(name: string) {
            shortcuts.push(name);
        },
    };

    registerShortcuts(
        pi as never,
        new BackgroundRegistry({ disableCtrlBShortcut })
    );
    return shortcuts;
}

void describe("shortcut registration", () => {
    void it("registers Ctrl+B by default", () => {
        assert.deepEqual(registeredShortcuts(false), [
            "ctrl+b",
            "ctrl+shift+b",
            "ctrl+shift+j",
            "shift+down",
            "ctrl+shift+x",
        ]);
    });

    void it("can leave Pi's built-in Ctrl+B shortcut untouched", () => {
        assert.deepEqual(registeredShortcuts(true), [
            "ctrl+shift+b",
            "ctrl+shift+j",
            "shift+down",
            "ctrl+shift+x",
        ]);
    });
});
