/**
 * 定时任务存储：`<工作区>/.open-assistant/jobs.json` 单文件事实源。
 *
 * 对齐 specs/agent-scheduling：
 * - 定时任务按工作区存放（随工作区迁移；只在所属工作区触发）
 * - 文件损坏时不静默清空：非法 JSON 报错且**拒绝写入**（照抄 `src/todos.ts` 的手法）
 * - 原子写：同目录临时文件 + fsync + rename；进程内按路径串行化
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import { ensureAppDataDir, workspaceAppDataDir } from "../workspace.js";
import { JobError, normalizeJobSpec, type JobRun, type JobSpec } from "./types.js";

export const JOBS_FILE = "jobs.json";

/** `<工作区>/.open-assistant/jobs.json` 的绝对路径 */
export function workspaceJobsPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), JOBS_FILE);
}

export interface JobsFile {
  version: 1;
  updatedAt: string;
  jobs: JobSpec[];
}

export interface JobsSnapshot {
  file: JobsFile;
  /** null 表示文件不存在 */
  etag: string | null;
  exists: boolean;
}

export function emptyJobsFile(now: string = new Date().toISOString()): JobsFile {
  return { version: 1, updatedAt: now, jobs: [] };
}

function etagOf(raw: string): string {
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}

async function readRaw(workspaceDir: string): Promise<string | null> {
  try {
    return await fs.readFile(workspaceJobsPath(workspaceDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** 校验并归一化整个文件（非法结构 → JobError，调用方不得以空列表覆盖） */
export function normalizeJobsFile(raw: unknown): JobsFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new JobError("JOB_INVALID_INPUT", "jobs.json 根必须是对象");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new JobError("JOB_INVALID_INPUT", `不支持的 jobs 版本: ${JSON.stringify(record.version)}`);
  }
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new JobError("JOB_INVALID_INPUT", "jobs.json 缺少合法的 updatedAt");
  }
  if (!Array.isArray(record.jobs)) {
    throw new JobError("JOB_INVALID_INPUT", "jobs.json 的 jobs 必须是数组");
  }
  const jobs = record.jobs.map((job, i) => {
    const spec = normalizeJobSpec(job, { requireId: true });
    return spec;
  });
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.id)) {
      throw new JobError("JOB_INVALID_INPUT", `重复的任务 id: ${job.id}`);
    }
    seen.add(job.id);
  }
  return { version: 1, updatedAt: record.updatedAt, jobs };
}

/**
 * 读取任务。文件不存在 → 视为空（不报错、不落盘）。
 * 非法 JSON / 结构非法 → 抛错（调用方不得以空列表覆盖）。
 */
export async function readJobs(workspaceDir: string): Promise<JobsSnapshot> {
  const raw = await readRaw(workspaceDir);
  if (raw === null) {
    return { file: emptyJobsFile(), etag: null, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JobError(
      "JOB_INVALID_JSON",
      `jobs.json 不是合法 JSON，已拒绝读取/写入以免覆盖：${(err as Error).message}`,
      422,
    );
  }
  return { file: normalizeJobsFile(parsed), etag: etagOf(raw), exists: true };
}

// —— 进程内串行化（同 todos.ts） ——
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function atomicWriteLocked(workspaceDir: string, file: JobsFile): Promise<{ etag: string }> {
  const filePath = workspaceJobsPath(workspaceDir);
  // 现有文件是非法 JSON 时拒绝写入，绝不覆盖（对齐「文件损坏时不静默清空」）。
  const currentRaw = await readRaw(workspaceDir);
  if (currentRaw !== null) {
    try {
      JSON.parse(currentRaw);
    } catch (err) {
      throw new JobError(
        "JOB_INVALID_JSON",
        `jobs.json 不是合法 JSON，已拒绝写入以免覆盖：${(err as Error).message}`,
        422,
      );
    }
  }
  const normalized = normalizeJobsFile({
    ...file,
    version: 1,
    updatedAt: file.updatedAt ?? new Date().toISOString(),
  });
  const payload: JobsFile = { version: 1, updatedAt: normalized.updatedAt, jobs: normalized.jobs };
  const serialized = JSON.stringify(payload, null, 2) + "\n";

  await ensureAppDataDir(workspaceDir);
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return { etag: etagOf(serialized) };
}

/** 整体覆盖写入（内部用；非法 JSON 会在写入前被 normalizeJobsFile 挡住） */
export async function writeJobs(workspaceDir: string, file: JobsFile): Promise<{ etag: string }> {
  return withLock(workspaceJobsPath(workspaceDir), () => atomicWriteLocked(workspaceDir, file));
}

/** 读取 - 修改 - 原子写回（同一把锁内完成，避免并发丢失更新） */
export async function mutateJobs<T>(
  workspaceDir: string,
  mutator: (jobs: JobSpec[], file: JobsFile) => { jobs?: JobSpec[]; result: T },
): Promise<T> {
  return withLock(workspaceJobsPath(workspaceDir), async () => {
    const snapshot = await readJobs(workspaceDir);
    const outcome = mutator(snapshot.file.jobs, snapshot.file);
    const nextJobs = outcome.jobs ?? snapshot.file.jobs;
    const now = new Date().toISOString();
    await atomicWriteLocked(workspaceDir, { version: 1, updatedAt: now, jobs: nextJobs });
    return outcome.result;
  });
}

/** 新建一条任务；id 由调用方生成（HTTP 层用 randomUUID） */
export async function createJobRecord(workspaceDir: string, spec: JobSpec): Promise<JobsFile> {
  return mutateJobs(workspaceDir, (jobs) => {
    if (jobs.some((j) => j.id === spec.id)) {
      throw new JobError("JOB_CONFLICT", `任务 id 已存在: ${spec.id}`, 409, "id");
    }
    return { jobs: [...jobs, spec], result: { version: 1, updatedAt: new Date().toISOString(), jobs: [...jobs, spec] } };
  });
}

export async function getJob(workspaceDir: string, id: string): Promise<JobSpec | null> {
  const snapshot = await readJobs(workspaceDir);
  return snapshot.file.jobs.find((j) => j.id === id) ?? null;
}

/** 用已有任务覆盖更新（校验交给调用方或 normalizeJobSpec） */
export async function replaceJobRecord(workspaceDir: string, spec: JobSpec): Promise<JobsFile> {
  return mutateJobs(workspaceDir, (jobs) => {
    const index = jobs.findIndex((j) => j.id === spec.id);
    if (index < 0) throw new JobError("JOB_NOT_FOUND", `任务不存在: ${spec.id}`, 404);
    const next = jobs.slice();
    next[index] = spec;
    return { jobs: next, result: { version: 1, updatedAt: new Date().toISOString(), jobs: next } };
  });
}

export async function deleteJobRecord(workspaceDir: string, id: string): Promise<JobsFile> {
  return mutateJobs(workspaceDir, (jobs) => {
    const index = jobs.findIndex((j) => j.id === id);
    if (index < 0) throw new JobError("JOB_NOT_FOUND", `任务不存在: ${id}`, 404);
    const next = jobs.filter((j) => j.id !== id);
    return { jobs: next, result: { version: 1, updatedAt: new Date().toISOString(), jobs: next } };
  });
}

export interface AppendRunPatch {
  nextRunAt?: string | null;
  threadId?: string;
}

/** 只更新任务的内部字段（nextRunAt / threadId / enabled），不追加执行记录 */
export async function patchJob(
  workspaceDir: string,
  id: string,
  patch: Partial<Pick<JobSpec, "nextRunAt" | "threadId" | "enabled">>,
): Promise<JobSpec> {
  return mutateJobs(workspaceDir, (jobs) => {
    const index = jobs.findIndex((j) => j.id === id);
    if (index < 0) throw new JobError("JOB_NOT_FOUND", `任务不存在: ${id}`, 404);
    const updated: JobSpec = { ...jobs[index]!, ...patch };
    const next = jobs.slice();
    next[index] = updated;
    return { jobs: next, result: updated };
  });
}

/** 追加一条执行记录（并可选更新 nextRunAt / threadId），返回更新后的任务 */
export async function appendJobRun(
  workspaceDir: string,
  id: string,
  run: JobRun,
  patch: AppendRunPatch = {},
): Promise<JobSpec> {
  return mutateJobs(workspaceDir, (jobs) => {
    const index = jobs.findIndex((j) => j.id === id);
    if (index < 0) throw new JobError("JOB_NOT_FOUND", `任务不存在: ${id}`, 404);
    const current = jobs[index]!;
    const lastRuns = [...(current.lastRuns ?? []), run];
    const updated: JobSpec = {
      ...current,
      lastRuns,
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      ...(patch.threadId ? { threadId: patch.threadId } : {}),
    };
    const next = jobs.slice();
    next[index] = updated;
    return { jobs: next, result: updated };
  });
}