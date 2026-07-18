import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DISABLE_CTRL_B_ENV,
    isCtrlBShortcutDisabled,
} from "../config.ts";

void describe("Ctrl+B configuration", () => {
    void it("is enabled by default", () => {
        assert.equal(isCtrlBShortcutDisabled({}), false);
    });

    void it("accepts conventional true values", () => {
        for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
            assert.equal(
                isCtrlBShortcutDisabled({ [DISABLE_CTRL_B_ENV]: value }),
                true,
                value
            );
        }
    });

    void it("does not disable Ctrl+B for false or unknown values", () => {
        for (const value of ["", "0", "false", "no", "off", "enabled"]) {
            assert.equal(
                isCtrlBShortcutDisabled({ [DISABLE_CTRL_B_ENV]: value }),
                false,
                value
            );
        }
    });
});
