/**
 * 定时任务的字段 / 校验。
 *
 * 字段形状**以后端为准**（前端 `apps/web/src/lib/jobsApi.ts` 的 `JobSpec` 是权威展示契约）：
 *   { id, name, enabled, heartbeat, content, schedule, dispatch, silent, runtime,
 *     lastRuns?, nextRunAt? }
 *
 * 我们额外落两个前端已知字段之外、但 spec/任务说明要求的字段：
 * - `meta.saveResult`：「文本任务 + 周期」默认不保存执行结果到会话，其他组合默认保存
 *   （前端 `jobPayload` 会原样保留未知字段，因此编辑不会丢）。
 * - `threadId`：该任务投递到本工作区会话时复用的会话标识（内部字段，前端原样保留）。
 */
import { normalizeCronExpression, validateTimezone } from "./cron.js";

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

export interface JobContent {
  kind: JobContentKind;
  text: string;
}

export interface JobScheduleEnd {
  kind: JobEndKind;
  until?: string;
  count?: number;
}

export interface JobSchedule {
  kind: JobScheduleKind;
  at?: string;
  cron?: string;
  timezone?: string;
  end?: JobScheduleEnd;
}

export interface JobDispatch {
  mode: JobDispatchMode;
}

export interface JobRuntime {
  concurrency: number;
  timeoutSeconds: number;
  graceSeconds: number;
}

export interface JobMeta {
  /** 是否把执行结果写进本工作区会话（文本 + 周期默认 false） */
  saveResult: boolean;
}

export interface JobSpec {
  id: string;
  name: string;
  enabled: boolean;
  heartbeat: boolean;
  content: JobContent;
  schedule: JobSchedule;
  dispatch: JobDispatch;
  silent: boolean;
  runtime: JobRuntime;
  lastRuns?: JobRun[];
  nextRunAt?: string | null;
  meta?: JobMeta;
  /** 投递复用的会话标识（内部字段，前端 raw 原样保留） */
  threadId?: string;
  /** 解析后的原始记录（前端用于保留未知字段） */
  raw?: Record<string, unknown>;
}

export const DEFAULT_JOB_RUNTIME: JobRuntime = {
  concurrency: 1,
  timeoutSeconds: 600,
  graceSeconds: 300,
};

export type JobErrorCode =
  | "JOB_INVALID_JSON"
  | "JOB_INVALID_INPUT"
  | "JOB_INVALID_CRON"
  | "JOB_SILENT_TEXT"
  | "JOB_NOT_FOUND"
  | "JOB_CONFLICT";

export class JobError extends Error {
  readonly code: JobErrorCode;
  readonly status: number;
  readonly field?: string;

  constructor(code: JobErrorCode, message: string, status = 400, field?: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new JobError("JOB_INVALID_INPUT", `${field} 必须是对象`, 400, field);
  return value;
}

/**
 * 文本任务 + 静默是非法组合（specs/agent-scheduling「文本任务不支持静默」）。
 * 其余组合照常。
 */
export function assertNotSilentText(kind: JobContentKind, silent: boolean): void {
  if (kind === "text" && silent) {
    throw new JobError(
      "JOB_SILENT_TEXT",
      "固定文本任务不支持静默：静默会让它既不投递也不产生任何可见结果，请关闭静默或改成交给 agent 的任务",
      400,
      "silent",
    );
  }
}

/** 按 spec 计算 `meta.saveResult` 默认值：文本 + 周期默认不保存，其他默认保存 */
export function defaultSaveResult(kind: JobContentKind, scheduleKind: JobScheduleKind, heartbeat = false): boolean {
  if (heartbeat) return true;
  return !(kind === "text" && scheduleKind === "periodic");
}

function normalizeRun(raw: unknown, index: number): JobRun {
  const record = requireRecord(raw, `lastRuns[${index}]`);
  const at = asString(record.at);
  const status = asString(record.status);
  if (!at || Number.isNaN(Date.parse(at))) {
    throw new JobError("JOB_INVALID_INPUT", `lastRuns[${index}].at 缺失或不是时间`);
  }
  const statuses: readonly string[] = ["ok", "error", "skipped", "running"];
  if (!status || !statuses.includes(status)) {
    throw new JobError("JOB_INVALID_INPUT", `lastRuns[${index}].status 非法: ${JSON.stringify(status)}`);
  }
  const run: JobRun = { at, status: status as JobRunStatus };
  const message = asString(record.message);
  if (message !== undefined) run.message = message;
  return run;
}

export interface NormalizeJobOptions {
  /** 是否要求 id 已存在（读取已有记录时为 true） */
  requireId?: boolean;
  /** 生成 id 用（POST 时由调用方传入；此处不生成） */
  now?: Date;
}

/**
 * 校验并归一化一条完整任务。
 * - 缺字段 / 类型错 / 非法组合 → 抛 JobError（不静默用默认值掩盖）
 * - cron 4/3 段补位 + DOW 数字转缩写
 * - 文本 + 静默 → 拒绝
 * - `meta.saveResult` 缺省按规则补齐
 */
export function normalizeJobSpec(raw: unknown, options: NormalizeJobOptions = {}): JobSpec {
  const record = requireRecord(raw, "job");
  const id = asString(record.id);
  if (options.requireId && (!id || id.length === 0)) {
    throw new JobError("JOB_INVALID_INPUT", "任务缺少 id", 400, "id");
  }

  const name = asString(record.name);
  if (!name || name.trim().length === 0) {
    throw new JobError("JOB_INVALID_INPUT", "任务必须提供非空 name", 400, "name");
  }

  const content = requireRecord(record.content, "content");
  const heartbeat = record.heartbeat === true;
  const contentKindRaw = asString(content.kind);
  if (contentKindRaw !== "text" && contentKindRaw !== "agent") {
    throw new JobError("JOB_INVALID_INPUT", `content.kind 非法: ${JSON.stringify(contentKindRaw)}（仅 text / agent）`, 400, "content.kind");
  }
  const contentText = asString(content.text);
  if (contentText === undefined) {
    throw new JobError("JOB_INVALID_INPUT", "content.text 必须是字符串", 400, "content.text");
  }
  // 心跳任务的请求来自 agent 的心跳文件，content.text 允许为空
  if (contentText.trim().length === 0 && !heartbeat) {
    throw new JobError("JOB_INVALID_INPUT", "content.text 不能为空", 400, "content.text");
  }

  const schedule = requireRecord(record.schedule, "schedule");
  const scheduleKindRaw = asString(schedule.kind);
  if (scheduleKindRaw !== "once" && scheduleKindRaw !== "periodic") {
    throw new JobError("JOB_INVALID_INPUT", `schedule.kind 非法: ${JSON.stringify(scheduleKindRaw)}（仅 once / periodic）`, 400, "schedule.kind");
  }
  const scheduleKind = scheduleKindRaw;

  let at: string | undefined;
  let cron: string | undefined;
  let timezone: string | undefined;
  const endRecord = isRecord(schedule.end) ? schedule.end : {};
  const endKindRaw = asString(endRecord.kind) ?? "never";
  if (!["never", "until", "count"].includes(endKindRaw)) {
    throw new JobError("JOB_INVALID_INPUT", `schedule.end.kind 非法: ${JSON.stringify(endKindRaw)}`, 400, "schedule.end.kind");
  }
  const endKind = endKindRaw as JobEndKind;
  const end: JobScheduleEnd = { kind: endKind };

  if (scheduleKind === "once") {
    at = asString(schedule.at);
    if (!at || Number.isNaN(Date.parse(at))) {
      throw new JobError("JOB_INVALID_INPUT", "一次性任务必须提供合法的 schedule.at（ISO 时刻）", 400, "schedule.at");
    }
  } else {
    const rawCron = schedule.cron ?? schedule.expr;
    cron = normalizeCronExpression(rawCron).expression;
    timezone = validateTimezone(schedule.timezone);
  }

  if (endKind === "until") {
    const until = asString(endRecord.until);
    if (!until || Number.isNaN(Date.parse(until))) {
      throw new JobError("JOB_INVALID_INPUT", "结束条件 until 必须提供合法时刻", 400, "schedule.end.until");
    }
    end.until = until;
  } else if (endKind === "count") {
    const count = endRecord.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new JobError("JOB_INVALID_INPUT", "结束条件 count 必须是 >=1 的整数", 400, "schedule.end.count");
    }
    end.count = count;
  }

  const dispatch = requireRecord(record.dispatch, "dispatch");
  const dispatchModeRaw = asString(dispatch.mode) ?? "stream";
  if (dispatchModeRaw !== "stream" && dispatchModeRaw !== "final") {
    throw new JobError("JOB_INVALID_INPUT", `dispatch.mode 非法: ${JSON.stringify(dispatchModeRaw)}`, 400, "dispatch.mode");
  }

  const silent = record.silent === true;
  assertNotSilentText(contentKindRaw, silent);

  const runtimeRecord = requireRecord(record.runtime ?? {}, "runtime");
  const concurrency = readNonNegativeInt(runtimeRecord.concurrency, DEFAULT_JOB_RUNTIME.concurrency, 1);
  const timeoutSeconds = readNonNegativeInt(
    runtimeRecord.timeoutSeconds ?? runtimeRecord.timeout,
    DEFAULT_JOB_RUNTIME.timeoutSeconds,
    1,
  );
  const graceSeconds = readNonNegativeInt(
    runtimeRecord.graceSeconds ?? runtimeRecord.grace,
    DEFAULT_JOB_RUNTIME.graceSeconds,
    0,
  );

  const metaRecord = isRecord(record.meta) ? record.meta : {};
  const saveResult =
    typeof metaRecord.saveResult === "boolean"
      ? metaRecord.saveResult
      : defaultSaveResult(contentKindRaw, scheduleKind, heartbeat);

  const spec: JobSpec = {
    id: id ?? "",
    name: name.trim(),
    enabled: record.enabled !== false,
    heartbeat,
    content: { kind: contentKindRaw, text: contentText },
    schedule: { kind: scheduleKind, ...(at ? { at } : {}), ...(cron ? { cron } : {}), ...(timezone ? { timezone } : {}), end },
    dispatch: { mode: dispatchModeRaw },
    silent,
    runtime: { concurrency, timeoutSeconds, graceSeconds },
    meta: { saveResult },
  };

  const nextRunAt = record.nextRunAt;
  if (nextRunAt === null) {
    spec.nextRunAt = null;
  } else if (isIsoDate(nextRunAt)) {
    spec.nextRunAt = nextRunAt;
  } else if (nextRunAt !== undefined) {
    throw new JobError("JOB_INVALID_INPUT", "nextRunAt 必须是 ISO 时刻或 null", 400, "nextRunAt");
  }

  const runs = record.lastRuns;
  if (runs !== undefined) {
    if (!Array.isArray(runs)) {
      throw new JobError("JOB_INVALID_INPUT", "lastRuns 必须是数组", 400, "lastRuns");
    }
    spec.lastRuns = runs.map((r, i) => normalizeRun(r, i));
  }

  const threadId = asString(record.threadId);
  if (threadId && threadId.length > 0) spec.threadId = threadId;

  return spec;
}

function readNonNegativeInt(value: unknown, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new JobError("JOB_INVALID_INPUT", `runtime 字段必须是整数，收到 ${JSON.stringify(value)}`);
  }
  if (value < min) {
    throw new JobError("JOB_INVALID_INPUT", `runtime 字段必须 >= ${min}，收到 ${value}`);
  }
  return value;
}

/** 允许 PATCH 的顶层字段（其余字段忽略，避免前端未知字段污染） */
const PATCHABLE_KEYS = new Set([
  "name",
  "enabled",
  "heartbeat",
  "content",
  "schedule",
  "dispatch",
  "silent",
  "runtime",
  "meta",
]);

/** 合并局部更新：熟悉的字段整体替换（schedule.end 嵌套合并），未知字段保留 */
export function applyJobPatch(existing: JobSpec, patch: unknown): unknown {
  const record = requireRecord(patch, "patch");
  const merged: Record<string, unknown> = {
    id: existing.id,
    name: existing.name,
    enabled: existing.enabled,
    heartbeat: existing.heartbeat,
    content: existing.content,
    schedule: existing.schedule,
    dispatch: existing.dispatch,
    silent: existing.silent,
    runtime: existing.runtime,
    meta: existing.meta,
    lastRuns: existing.lastRuns,
    nextRunAt: existing.nextRunAt,
  };
  if (existing.threadId) merged.threadId = existing.threadId;

  for (const [key, value] of Object.entries(record)) {
    if (!PATCHABLE_KEYS.has(key)) continue;
    if (key === "schedule" && isRecord(value) && isRecord(existing.schedule)) {
      merged.schedule = {
        ...existing.schedule,
        ...value,
        ...(isRecord(value.end) || isRecord(existing.schedule.end)
          ? { end: { ...(existing.schedule.end ?? { kind: "never" }), ...(isRecord(value.end) ? value.end : {}) } }
          : {}),
      };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}