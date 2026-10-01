/**
 * 任务发生时刻展开（日历主 tab 用）：一次性任务 + 周期任务（cron）。
 */
import { describe, expect, test } from "bun:test";

import { expandJobOccurrences } from "../src/jobs/occurrences.js";
import type { JobSpec } from "../src/jobs/types.js";

function job(partial: Partial<JobSpec> & Pick<JobSpec, "id" | "name" | "schedule">): JobSpec {
  return {
    enabled: true,
    heartbeat: false,
    content: { kind: "text", text: "x" },
    dispatch: { mode: "final" },
    silent: false,
    runtime: { concurrency: 1, timeoutSeconds: 600, graceSeconds: 300 },
    ...partial,
  } as JobSpec;
}

describe("expandJobOccurrences", () => {
  test("一次性任务：落在区间内才出现", () => {
    const j = job({
      id: "once",
      name: "一次性",
      schedule: { kind: "once", at: "2026-10-03T01:00:00.000Z" },
    });
    const hit = expandJobOccurrences([j], "2026-10-01T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
    expect(hit.map((o) => o.jobId)).toEqual(["once"]);
    const miss = expandJobOccurrences([j], "2026-10-05T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
    expect(miss).toEqual([]);
  });

  test("周期任务：按 cron 展开并排序，区间右端之外不出现", () => {
    const j = job({
      id: "daily",
      name: "每天九点",
      schedule: { kind: "periodic", cron: "0 9 * * *", timezone: "UTC" },
    });
    const out = expandJobOccurrences([j], "2026-10-01T00:00:00.000Z", "2026-10-03T12:00:00.000Z");
    // 10-01 09:00、10-02 09:00、10-03 09:00
    expect(out.map((o) => o.at)).toEqual([
      "2026-10-01T09:00:00.000Z",
      "2026-10-02T09:00:00.000Z",
      "2026-10-03T09:00:00.000Z",
    ]);
  });

  test("停用的任务、非法 cron、非法区间都不产出", () => {
    const disabled = job({
      id: "off",
      name: "停用",
      enabled: false,
      schedule: { kind: "periodic", cron: "0 9 * * *" },
    });
    const bad = job({ id: "bad", name: "坏 cron", schedule: { kind: "periodic", cron: "not a cron" } });
    const out = expandJobOccurrences([disabled, bad], "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z");
    expect(out).toEqual([]);
    expect(expandJobOccurrences([disabled], "bad", "also-bad")).toEqual([]);
    expect(expandJobOccurrences([disabled], "2026-10-03T00:00:00.000Z", "2026-10-01T00:00:00.000Z")).toEqual([]);
  });

  test("结束条件（until）之后不再产出", () => {
    const j = job({
      id: "until",
      name: "到 10-02 为止",
      schedule: {
        kind: "periodic",
        cron: "0 9 * * *",
        timezone: "UTC",
        end: { kind: "until", until: "2026-10-02T00:00:00.000Z" },
      },
    });
    const out = expandJobOccurrences([j], "2026-10-01T00:00:00.000Z", "2026-10-05T00:00:00.000Z");
    expect(out.map((o) => o.at)).toEqual(["2026-10-01T09:00:00.000Z"]);
  });
});