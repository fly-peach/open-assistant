/**
 * 把工作区里的定时任务**展开成一段时间内的发生时刻**（日历主 tab 用）。
 *
 * - 一次性任务：它自己的 `at`；
 * - 周期任务：用 cron-parser 按 cron + 时区逐次求值，直到区间右端（或任务的结束条件）；
 * - 非法 cron / 已停用的任务跳过（任务本身在别处会标注校验错误）。
 */
import { CronExpressionParser } from "cron-parser";

import type { JobSpec } from "./types.js";

export interface JobOccurrence {
  jobId: string;
  name: string;
  /** 发生时刻（ISO） */
  at: string;
  kind: "once" | "periodic";
}

/**
 * 展开 `[fromIso, toIso]` 区间内的任务发生时刻，按时间升序。
 * `perJobLimit` 防止「每分钟一次」这类任务把区间撑爆。
 */
export function expandJobOccurrences(
  jobs: readonly JobSpec[],
  fromIso: string,
  toIso: string,
  perJobLimit = 300,
): JobOccurrence[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return [];

  const out: JobOccurrence[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    const schedule = job.schedule;

    if (schedule.kind === "once") {
      if (!schedule.at) continue;
      const at = new Date(schedule.at);
      if (!Number.isNaN(at.getTime()) && at >= from && at <= to) {
        out.push({ jobId: job.id, name: job.name, at: at.toISOString(), kind: "once" });
      }
      continue;
    }

    if (!schedule.cron) continue;
    const endDate =
      schedule.end?.kind === "until" && schedule.end.until
        ? new Date(schedule.end.until)
        : undefined;
    try {
      const it = CronExpressionParser.parse(schedule.cron, {
        // 减 1ms：让「正好落在区间左端」的那一次也算进来
        currentDate: new Date(from.getTime() - 1),
        ...(schedule.timezone ? { tz: schedule.timezone } : {}),
      });
      let count = 0;
      while (count < perJobLimit) {
        if (!it.hasNext()) break;
        const next = it.next().toDate();
        if (next > to) break;
        if (endDate && next > endDate) break;
        out.push({ jobId: job.id, name: job.name, at: next.toISOString(), kind: "periodic" });
        count += 1;
      }
    } catch {
      // 非法 cron：交给任务自己的校验错误去报，这里跳过
    }
  }

  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}