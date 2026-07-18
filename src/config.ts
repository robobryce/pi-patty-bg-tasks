/** Environment variable that leaves Pi's built-in Ctrl+B binding untouched. */
export const DISABLE_CTRL_B_ENV = "PI_PATTY_BG_TASKS_DISABLE_CTRL_B";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** Resolve whether the extension should skip its Ctrl+B shortcut registration. */
export function isCtrlBShortcutDisabled(
    env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
    const value = env[DISABLE_CTRL_B_ENV];
    return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}
