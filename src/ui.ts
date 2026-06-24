/**
 * 백그라운드 작업 TUI 패널 — /bg-list 인터랙티브 매니저.
 *
 * pi의 ctx.ui.select() API를 사용해 Claude Code 스타일의 잡 관리를 제공한다.
 * - 목록에서 잡 선택
 * - 출력 보기 / 종료 / 제거 액션
 * - 로캘에 따른 한/영 표시
 */

import type { Job, UiContext } from "./types.ts";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration } from "./format.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import {
    forget,
    readLogTail,
    renderSidebar,
} from "./registry.ts";

// ─── 로캘 ─────────────────────────────────────────��───────────────────

type Locale = "en" | "ko";

/** en 기본. ko는 LANG/LC_ALL/LANGUAGE가 명시적으로 ko일 때만. */
function getLocale(): Locale {
    const lang = (process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? "").toLowerCase();
    return lang.startsWith("ko") ? "ko" : "en";
}

const L = {
    en: {
        title: "Background Tasks",
        empty: "No background tasks",
        running: "running",
        completed: "completed",
        failed: "failed",
        killed: "killed",
        actions: "Actions",
        showOutput: "Show Output",
        kill: "Kill",
        remove: "Remove",
        attach: "Attach (wait for completion)",
        back: "← Back to list",
        exitCode: "Exit code",
        status: "Status",
        pid: "PID",
        started: "Started",
        duration: "Duration",
        log: "Log",
        command: "Command",
        output: "OUTPUT",
        killed_msg: (name: string) => `Killed ${name}`,
        removed_msg: (name: string) => `Removed ${name}`,
    },
    ko: {
        title: "백그라운드 작업",
        empty: "백그라운드 작업 없음",
        running: "실행 중",
        completed: "완료",
        failed: "실패",
        killed: "종료됨",
        actions: "액션",
        showOutput: "출력 보기",
        kill: "종료",
        remove: "제거",
        attach: "완료까지 대기",
        back: "← 목록으로",
        exitCode: "종료 코드",
        status: "상태",
        pid: "PID",
        started: "시작",
        duration: "소요 시간",
        log: "로그",
        command: "명령",
        output: "출력",
        killed_msg: (name: string) => `${name} 종료됨`,
        removed_msg: (name: string) => `${name} 제거됨`,
    },
} as const;

// ─── 패널 열기 ──────────────────────────────────────────────────────

/**
 * /bg-list 패널 — 잡 목록 선택 → 액션 선택 → 실행 루프.
 * Escape/취소 시 자동 닫힘.
 */
export async function openBgListPanel(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    const t = L[getLocale()];

    // 목록 루프 — 사용자가 esc를 누를 때까지 반복.
    while (true) {
        const jobs = getJobList(reg);
        if (jobs.length === 0) {
            ctx.ui.notify(t.empty, "info");
            return;
        }

        // 잡 목록 구성.
        const items = jobs.map((job) => {
            const icon = statusIcon(job);
            const dur = formatDuration(Date.now() - job.startTime);
            const label = job.name ? `${job.name} (${job.id})` : job.id;
            const statusStr = job.status === "running"
                ? `${t.running} (${dur})`
                : t[job.status];
            const cmd = job.command.slice(0, PREVIEW_CHARS.taskList);
            return `${icon} ${label}: ${cmd} · ${statusStr}`;
        });

        const choice = await ctx.ui.select(t.title, items);
        if (choice === undefined) return; // esc → 닫기.

        // 선택된 잡 찾기.
        const idx = items.indexOf(choice);
        const job = jobs[idx];
        if (!job) return;

        // 액션 루프.
        const continued = await showJobActions(job, reg, ctx, t);
        if (!continued) return; // 사용자가 esc.
    }
}

// ─── 잡 액션 ───────────────────────────────────────────────���──────────

async function showJobActions(
    job: Job,
    reg: BackgroundRegistry,
    ctx: UiContext,
    t: (typeof L)[Locale]
): Promise<boolean> {
    const name = job.name ?? job.id;

    if (job.status === "running") {
        const options = [t.showOutput, t.kill, t.attach, t.back];
        const action = await ctx.ui.select(
            `▶ ${name} · ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
            options
        );
        if (action === undefined) return false;

        if (action === t.showOutput) {
            await showOutput(job, ctx, t);
            return true;
        }
        if (action === t.kill) {
            terminateJobSilently(reg, job);
            renderSidebar(reg, ctx);
            ctx.ui.notify(t.killed_msg(name), "info");
            return true;
        }
        if (action === t.attach) {
            ctx.ui.setStatus("attach-flow", `Attaching to ${name}...`);
            const { ensureCompletionPromise } = await import("./lifecycle.ts");
            ensureCompletionPromise(job);
            await job.donePromise;
            ctx.ui.setStatus("attach-flow", undefined);
            await showOutput(job, ctx, t);
            return true;
        }
        return true; // back.
    }

    // 터미널 잡.
    const options = [t.showOutput, t.remove, t.back];
    const action = await ctx.ui.select(
        `${statusIcon(job)} ${name} · ${t[job.status]}`,
        options
    );
    if (action === undefined) return false;

    if (action === t.showOutput) {
        await showOutput(job, ctx, t);
        return true;
    }
    if (action === t.remove) {
        forget(reg, job);
        renderSidebar(reg, ctx);
        ctx.ui.notify(t.removed_msg(name), "info");
        return true;
    }
    return true; // back.
}

// ─── 출력 표시 ─────────────────────────────────────────────���────────

async function showOutput(
    job: Job,
    ctx: UiContext,
    t: (typeof L)[Locale]
): Promise<void> {
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    const dur = formatDuration(Date.now() - job.startTime);
    const exitLine = job.exitCode !== undefined
        ? `\n${t.exitCode}: ${job.exitCode}`
        : "";

    await ctx.ui.editor(
        `${statusIcon(job)} ${job.name ?? job.id}: ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
        `${t.command}: ${job.command}\n` +
            `${t.pid}: ${job.pid} · ${t.started}: ${new Date(job.startTime).toLocaleString()}\n` +
            `${t.duration}: ${dur} · ${t.status}: ${t[job.status]}${exitLine}\n` +
            `${t.log}: ${job.logPath}\n\n` +
            `--- ${t.output} ---\n${out}`
    );
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────

function getJobList(reg: BackgroundRegistry): Job[] {
    const all = Array.from(reg.jobs.values());
    const running = all.filter((j) => j.status === "running")
        .sort((a, b) => b.startTime - a.startTime);
    const terminal = all.filter((j) => j.status !== "running")
        .sort((a, b) => b.startTime - a.startTime);
    return [...running, ...terminal];
}

function statusIcon(job: Job): string {
    switch (job.status) {
        case "running":
            return "▶";
        case "completed":
            return "✓";
        case "failed":
            return "✗";
        case "killed":
            return "✗";
    }
}
