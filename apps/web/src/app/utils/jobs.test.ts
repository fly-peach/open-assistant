/**
 * 任务 6.1 / 6.2 的纯函数校验：任务字段归一化与表单映射。
 * 重点断言 spec 里的两条硬约束：
 * - 「固定文本任务不支持静默」；
 * - 结束条件（不限 / 截止时间 / 执行次数）与运行约束都能落到载荷里。
 */
import { describe, expect, test } from "bun:test";
import {
  emptyJob,
  formToJob,
  jobFormError,
  jobPayload,
  jobToForm,
  normalizeJob,
  normalizeJobs,
} from "@/lib/jobsApi";

describe("任务归一化（6.1）", () => {
  test("接受数组与 { jobs } 两种返回形状", () => {
    expect(normalizeJobs([{ id: "a" }]).map((job) => job.id)).toEqual(["a"]);
    expect(normalizeJobs({ jobs: [{ id: "a" }, { id: "b" }] })).toHaveLength(2);
    expect(normalizeJobs(null)).toEqual([]);
    expect(normalizeJob({})).toBeNull();
  });

  test("缺字段用默认值，不因缺字段丢任务", () => {
    const job = normalizeJob({ id: "j1" });
    expect(job?.name).toBe("j1");
    expect(job?.enabled).toBe(true);
    expect(job?.content.kind).toBe("agent");
    expect(job?.schedule.kind).toBe("periodic");
    expect(job?.schedule.end?.kind).toBe("never");
    expect(job?.dispatch.mode).toBe("stream");
    expect(job?.runtime).toEqual({
      concurrency: 1,
      timeoutSeconds: 600,
      graceSeconds: 300,
    });
  });

  test("一次性 / 周期、时区、结束条件、投递方式都能读出来", () => {
    const job = normalizeJob({
      id: "j2",
      content: { kind: "text", text: "喝水" },
      schedule: {
        kind: "once",
        at: "2026-01-01T09:00",
        timezone: "Asia/Shanghai",
        end: { kind: "count", count: 3 },
      },
      dispatch: { mode: "final" },
      silent: true,
      runtime: { concurrency: 2, timeoutSeconds: 30, graceSeconds: 5 },
    });
    expect(job?.content).toEqual({ kind: "text", text: "喝水" });
    expect(job?.schedule.kind).toBe("once");
    expect(job?.schedule.end).toEqual({ kind: "count", count: 3, until: undefined });
    expect(job?.dispatch.mode).toBe("final");
    expect(job?.silent).toBe(true);
    expect(job?.runtime.concurrency).toBe(2);
  });

  test("执行记录可追溯（状态与时刻）", () => {
    const job = normalizeJob({
      id: "j3",
      lastRuns: [
        { at: "2026-01-01T00:00", status: "ok" },
        { at: "2026-01-02T00:00", status: "error", message: "超时" },
        { at: "2026-01-03T00:00", status: "没这个状态" },
      ],
    });
    expect(job?.lastRuns?.map((run) => run.status)).toEqual(["ok", "error"]);
    expect(job?.lastRuns?.[1].message).toBe("超时");
  });
});

describe("表单映射（6.2）", () => {
  test("表单 ↔ 任务往返不丢字段", () => {
    const job = normalizeJob({
      id: "j1",
      name: "每天提醒",
      content: { kind: "agent", text: "汇总待办" },
      schedule: { kind: "periodic", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
      runtime: { concurrency: 3, timeoutSeconds: 60, graceSeconds: 10 },
    })!;
    const roundTrip = formToJob(jobToForm(job), job, job.id);
    expect(roundTrip.name).toBe("每天提醒");
    expect(roundTrip.schedule.cron).toBe("0 9 * * *");
    expect(roundTrip.runtime.concurrency).toBe(3);
    expect(roundTrip.content.text).toBe("汇总待办");
  });

  test("固定文本任务不支持静默（表单与载荷都拦）", () => {
    const form = {
      ...jobToForm(emptyJob("UTC")),
      name: "喝水提醒",
      contentKind: "text" as const,
      silent: true,
    };
    expect(jobFormError(form)).toBe("silentText");
    expect(formToJob(form).silent).toBe(false);
    expect(jobPayload(formToJob(form)).silent).toBe(false);
  });

  test("缺名称被拦下", () => {
    const form = { ...jobToForm(emptyJob("UTC")), name: "  " };
    expect(jobFormError(form)).toBe("name");
  });

  test("结束条件按类型落载荷：不限 / 截止 / 次数", () => {
    const base = jobToForm(emptyJob("UTC"));
    expect(jobPayload(formToJob({ ...base, endKind: "never" })).schedule).toEqual({
      kind: "periodic",
      cron: "0 9 * * *",
      timezone: "UTC",
      end: { kind: "never" },
    });
    const until = jobPayload(
      formToJob({ ...base, endKind: "until", endUntil: "2026-06-01" })
    ).schedule as Record<string, unknown>;
    expect(until.end).toEqual({ kind: "until", until: "2026-06-01" });
    const count = jobPayload(
      formToJob({ ...base, endKind: "count", endCount: "4" })
    ).schedule as Record<string, unknown>;
    expect(count.end).toEqual({ kind: "count", count: 4 });
  });

  test("一次性任务只带 at，周期任务只带 cron + 时区", () => {
    const base = jobToForm(emptyJob("UTC"));
    const once = jobPayload(
      formToJob({ ...base, scheduleKind: "once", at: "2026-01-01T09:00" })
    ).schedule as Record<string, unknown>;
    expect(once.at).toBe("2026-01-01T09:00");
    expect(once.cron).toBeUndefined();
  });

  test("载荷剥掉纯展示字段（lastRuns / nextRunAt）", () => {
    const job = normalizeJob({
      id: "j1",
      lastRuns: [{ at: "2026-01-01T00:00", status: "ok" }],
      nextRunAt: "2026-01-02T00:00",
    })!;
    const payload = jobPayload(job);
    expect(payload.lastRuns).toBeUndefined();
    expect(payload.nextRunAt).toBeUndefined();
  });
});