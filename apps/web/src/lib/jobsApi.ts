/**
 * 定时任务（按工作区）HTTP 客户端。
 *
 * 对齐 design.md D11 / specs/agent-scheduling 与 D9 的业务 API：
 * - `GET    /jobs?path=<ws>`        列本工作区任务
 * - `POST   /jobs`                  新建（body 带 `path`）
 * - `PATCH  /jobs/{id}?path=<ws>`   局部更新（启停 / 编辑）
 * - `DELETE /jobs/{id}?path=<ws>`   删除
 *
 * 任务保存在 `<工作区>/.open-assistant/jobs.json`，因此**所有请求都带工作区路径**，
 * 两个工作区的任务互不可见（任务只在所属工作区触发）。
 *
 * 字段形状以后端为准；这里给出表单需要的规范化默认值，未知字段保留在 `raw` 里。
 */
import { request } from "@/lib/workspaceApi";

export type JobContentKind = "text" | "agent";
export type JobScheduleKind = "once" | "periodic";
export type JobEndKind = "never" | "until" | "count";
export type JobDispatchMode = "stream" | "final";
export type JobRunStatus = "ok" | "error" | "skipped" | "running";

export interface JobRun {
  at: string;
  status: JobRunStatus;
  message?: string;
}

export interface JobSpec {
  id: string;
  name: string;
  enabled: boolean;
  /** 心跳任务：把智能体的心跳文件当请求，周期触发（specs/agent-scheduling「心跳」）。 */
  heartbeat: boolean;
  content: { kind: JobContentKind; text: string };
  schedule: {
    kind: JobScheduleKind;
    /** 一次性任务的执行时刻。 */
    at?: string;
    /** 周期任务的 cron 表达式。 */
    cron?: string;
    timezone?: string;
    end?: { kind: JobEndKind; until?: string; count?: number };
  };
  dispatch: { mode: JobDispatchMode };
  silent: boolean;
  runtime: { concurrency: number; timeoutSeconds: number; graceSeconds: number };
  lastRuns?: JobRun[];
  nextRunAt?: string | null;
  /** 后端返回的原始记录（未知字段原样保留，编辑时回写）。 */
  raw?: Record<string, unknown>;
}

export const DEFAULT_JOB_RUNTIME: JobSpec["runtime"] = {
  concurrency: 1,
  timeoutSeconds: 600,
  graceSeconds: 300,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const RUN_STATUSES: readonly JobRunStatus[] = ["ok", "error", "skipped", "running"];

function normalizeRun(raw: unknown): JobRun | null {
  const record = asRecord(raw);
  const at = asString(record.at) ?? asString(record.finishedAt) ?? asString(record.startedAt);
  const status = asString(record.status);
  if (!at || !status || !RUN_STATUSES.includes(status as JobRunStatus)) return null;
  return { at, status: status as JobRunStatus, message: asString(record.message) };
}

export function normalizeJob(raw: unknown): JobSpec | null {
  const record = asRecord(raw);
  const id = asString(record.id);
  if (!id) return null;

  const content = asRecord(record.content);
  const schedule = asRecord(record.schedule);
  const end = asRecord(schedule.end);
  const runtime = asRecord(record.runtime);
  const dispatch = asRecord(record.dispatch);
  const contentKind = asString(content.kind) ?? asString(record.contentKind) ?? "agent";
  const scheduleKind = asString(schedule.kind) ?? "periodic";
  const endKind = asString(end.kind) ?? "never";
  const dispatchMode = asString(dispatch.mode) ?? asString(record.dispatchMode) ?? "stream";

  return {
    id,
    name: asString(record.name) ?? id,
    enabled: record.enabled !== false,
    heartbeat: record.heartbeat === true || contentKind === "heartbeat",
    content: {
      kind: contentKind === "text" ? "text" : "agent",
      text: asString(content.text) ?? asString(record.contentText) ?? "",
    },
    schedule: {
      kind: scheduleKind === "once" ? "once" : "periodic",
      at: asString(schedule.at),
      cron: asString(schedule.cron) ?? asString(schedule.expr),
      timezone: asString(schedule.timezone),
      end: {
        kind:
          endKind === "until" || endKind === "count"
            ? (endKind as JobEndKind)
            : "never",
        until: asString(end.until),
        count: typeof end.count === "number" ? end.count : undefined,
      },
    },
    dispatch: { mode: dispatchMode === "final" ? "final" : "stream" },
    silent: record.silent === true,
    runtime: {
      concurrency: asNumber(runtime.concurrency, DEFAULT_JOB_RUNTIME.concurrency),
      timeoutSeconds: asNumber(
        runtime.timeoutSeconds ?? runtime.timeout,
        DEFAULT_JOB_RUNTIME.timeoutSeconds
      ),
      graceSeconds: asNumber(
        runtime.graceSeconds ?? runtime.grace,
        DEFAULT_JOB_RUNTIME.graceSeconds
      ),
    },
    lastRuns: (Array.isArray(record.lastRuns) ? record.lastRuns : [])
      .map(normalizeRun)
      .filter((item): item is JobRun => item !== null),
    nextRunAt: asString(record.nextRunAt) ?? null,
    raw: record,
  };
}

export function normalizeJobs(raw: unknown): JobSpec[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw).jobs;
  return (Array.isArray(list) ? list : [])
    .map(normalizeJob)
    .filter((item): item is JobSpec => item !== null);
}

/** 新建任务的默认草稿（周期 + 交给智能体 + 流式投递）。 */
export function emptyJob(timezone: string): JobSpec {
  return {
    id: "",
    name: "",
    enabled: true,
    heartbeat: false,
    content: { kind: "agent", text: "" },
    schedule: {
      kind: "periodic",
      cron: "0 9 * * *",
      timezone,
      end: { kind: "never", count: undefined, until: undefined },
    },
    dispatch: { mode: "stream" },
    silent: false,
    runtime: { ...DEFAULT_JOB_RUNTIME },
  };
}

function jobsListPath(workspace: string): string {
  return `/jobs?path=${encodeURIComponent(workspace)}`;
}

export function listJobs(workspace: string): Promise<JobSpec[]> {
  return request<unknown>(jobsListPath(workspace)).then(normalizeJobs);
}

/** 提交给后端的载荷：剥掉纯展示字段（lastRuns / nextRunAt / raw）。 */
export function jobPayload(job: JobSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...(job.raw ?? {}),
    name: job.name,
    enabled: job.enabled,
    heartbeat: job.heartbeat,
    content: { kind: job.content.kind, text: job.content.text },
    schedule: {
      kind: job.schedule.kind,
      ...(job.schedule.kind === "once"
        ? { at: job.schedule.at ?? "" }
        : { cron: job.schedule.cron ?? "", timezone: job.schedule.timezone ?? "" }),
      end: {
        kind: job.schedule.end?.kind ?? "never",
        ...(job.schedule.end?.kind === "until"
          ? { until: job.schedule.end.until ?? "" }
          : {}),
        ...(job.schedule.end?.kind === "count"
          ? { count: job.schedule.end.count ?? 1 }
          : {}),
      },
    },
    dispatch: { mode: job.dispatch.mode },
    // 固定文本任务不支持静默（specs/agent-scheduling「文本任务不支持静默」）。
    silent: job.content.kind === "agent" ? job.silent : false,
    runtime: { ...job.runtime },
  };
  delete payload.lastRuns;
  delete payload.nextRunAt;
  if (!payload.id) delete payload.id;
  return payload;
}

export function createJob(
  workspace: string,
  job: JobSpec
): Promise<{ id?: string }> {
  return request<{ id?: string }>("/jobs", {
    method: "POST",
    body: JSON.stringify({ path: workspace, ...jobPayload(job) }),
  });
}

/**
 * 局部更新：调用方传入已经成形的载荷字段（整份任务的 `jobPayload(job)`，
 * 或启停时的 `{ enabled }`），避免把未提供的字段覆盖成空值。
 */
export function updateJob(
  workspace: string,
  id: string,
  patch: Record<string, unknown>
): Promise<unknown> {
  return request(
    `/jobs/${encodeURIComponent(id)}?path=${encodeURIComponent(workspace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ path: workspace, ...patch }),
    }
  );
}

export function deleteJob(workspace: string, id: string): Promise<unknown> {
  return request(
    `/jobs/${encodeURIComponent(id)}?path=${encodeURIComponent(workspace)}`,
    { method: "DELETE" }
  );
}
/* ------------------------------------------------------------- 表单映射 */

/** 表单草稿：数字与时刻用字符串保存（输入框的自然形态），提交时再收敛。 */
export interface JobFormState {
  name: string;
  contentKind: JobContentKind;
  contentText: string;
  scheduleKind: JobScheduleKind;
  at: string;
  cron: string;
  timezone: string;
  endKind: JobEndKind;
  endUntil: string;
  endCount: string;
  dispatchMode: JobDispatchMode;
  silent: boolean;
  concurrency: string;
  timeoutSeconds: string;
  graceSeconds: string;
  heartbeat: boolean;
  enabled: boolean;
}

/** 本机时区（浏览器环境）；无法确定时退回一个固定值，仍可手动修改。 */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

export function jobToForm(job: JobSpec): JobFormState {
  return {
    name: job.name,
    contentKind: job.content.kind,
    contentText: job.content.text,
    scheduleKind: job.schedule.kind,
    at: job.schedule.at ?? "",
    cron: job.schedule.cron ?? "",
    timezone: job.schedule.timezone ?? localTimezone(),
    endKind: job.schedule.end?.kind ?? "never",
    endUntil: job.schedule.end?.until ?? "",
    endCount:
      job.schedule.end?.count !== undefined ? String(job.schedule.end.count) : "",
    dispatchMode: job.dispatch.mode,
    silent: job.silent,
    concurrency: String(job.runtime.concurrency),
    timeoutSeconds: String(job.runtime.timeoutSeconds),
    graceSeconds: String(job.runtime.graceSeconds),
    heartbeat: job.heartbeat,
    enabled: job.enabled,
  };
}

function toPositiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 表单 → 任务：`base` 用于保留未知字段与展示字段（编辑已有任务时不丢后端字段）。
 * 固定文本任务强制 `silent=false`（specs/agent-scheduling「文本任务不支持静默」）。
 */
export function formToJob(form: JobFormState, base?: JobSpec, id = ""): JobSpec {
  const source = base ?? emptyJob(form.timezone);
  const isText = form.contentKind === "text";
  return {
    ...source,
    id,
    name: form.name.trim(),
    enabled: form.enabled,
    heartbeat: form.heartbeat,
    content: { kind: form.contentKind, text: form.contentText },
    schedule: {
      kind: form.scheduleKind,
      at: form.at,
      cron: form.cron,
      timezone: form.timezone,
      end: {
        kind: form.endKind,
        until: form.endUntil,
        count:
          form.endKind === "count"
            ? toPositiveInt(form.endCount, 1)
            : undefined,
      },
    },
    dispatch: { mode: form.dispatchMode },
    silent: isText ? false : form.silent,
    runtime: {
      concurrency: toPositiveInt(form.concurrency, source.runtime.concurrency),
      timeoutSeconds: toPositiveInt(form.timeoutSeconds, source.runtime.timeoutSeconds),
      graceSeconds: toPositiveInt(form.graceSeconds, source.runtime.graceSeconds),
    },
  };
}

/** 校验：固定文本 + 静默是非法组合，提交前必须被拦住。 */
export function jobFormError(form: JobFormState): "silentText" | "name" | null {
  if (!form.name.trim()) return "name";
  if (form.contentKind === "text" && form.silent) return "silentText";
  return null;
}
