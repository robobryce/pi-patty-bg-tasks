/**
 * Streaming log search service.
 *
 * The jobs tool owns parameter parsing and result formatting; this module owns
 * full-log scanning, match counting, bounded display-hit retention, and tmux
 * fallback mechanics.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS, type Job } from "./types.ts";
import { readLogTail } from "./registry.ts";

export interface LogSearchHit {
    path: string;
    line: number;
    text: string;
}

export interface LogSearchGroup {
    jobId: string;
    name?: string;
    count: number;
    hits: LogSearchHit[];
}

export interface LogSearchResult {
    totalHits: number;
    groups: LogSearchGroup[];
}

export async function searchLogs(args: {
    jobs: Iterable<Job>;
    pattern: RegExp;
    maxHitsPerJob: number;
    maxLineChars?: number;
}): Promise<LogSearchResult> {
    const groups = new Map<string, LogSearchGroup>();
    const maxLineChars = args.maxLineChars ?? PREVIEW_CHARS.line;

    for (const job of args.jobs) {
        const scanned = await scanLogFile(job, args.pattern, groups, {
            maxHitsPerJob: args.maxHitsPerJob,
            maxLineChars,
        });
        if (!scanned && job.tmux) {
            scanText(
                job,
                args.pattern,
                readLogTail(job, OUTPUT_PREVIEW_CHARS),
                groups,
                { maxHitsPerJob: args.maxHitsPerJob, maxLineChars }
            );
        }
    }

    const orderedGroups = Array.from(groups.values());
    let totalHits = 0;
    for (const group of orderedGroups) totalHits += group.count;
    return { totalHits, groups: orderedGroups };
}

async function scanLogFile(
    job: Job,
    re: RegExp,
    groups: Map<string, LogSearchGroup>,
    options: { maxHitsPerJob: number; maxLineChars: number }
): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        let lineNo = 0;
        let sawFile = false;
        const stream = createReadStream(job.logPath, { encoding: "utf-8" });
        stream.on("error", () => resolve(false));
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        rl.on("line", (line) => {
            sawFile = true;
            lineNo++;
            re.lastIndex = 0;
            if (re.test(line)) {
                recordSearchHit(groups, job, {
                    path: job.logPath,
                    line: lineNo,
                    text: truncateLine(line, options.maxLineChars),
                }, options.maxHitsPerJob);
            }
        });
        rl.on("close", () => resolve(sawFile));
    });
}

function scanText(
    job: Job,
    re: RegExp,
    text: string,
    groups: Map<string, LogSearchGroup>,
    options: { maxHitsPerJob: number; maxLineChars: number }
): void {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
            recordSearchHit(groups, job, {
                path: `${job.logPath} (tmux pane tail)`,
                line: i + 1,
                text: truncateLine(lines[i], options.maxLineChars),
            }, options.maxHitsPerJob);
        }
    }
}

function truncateLine(line: string, maxChars: number): string {
    if (line.length <= maxChars) return line;
    return `${line.slice(0, maxChars)}...[truncated]`;
}

function recordSearchHit(
    groups: Map<string, LogSearchGroup>,
    job: Job,
    hit: LogSearchHit,
    maxHitsPerJob: number
): void {
    const group = groups.get(job.id) ?? {
        jobId: job.id,
        name: job.name,
        count: 0,
        hits: [],
    };
    group.count++;
    if (group.hits.length < maxHitsPerJob) {
        group.hits.push(hit);
    }
    groups.set(job.id, group);
}
