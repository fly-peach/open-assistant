/**
 * 单进程内调度器（对齐 specs/agent-scheduling「错过与失败的处理」）。
 *
 * 职责：判断哪些任务到点、按宽限窗口决定补跑与否并记录该决定、触发执行。
 * 不负责进程启动：`ensureSchedulerStarted` 只维护一个按工作区注册的注册表，
 * 由 HTTP `/jobs` 首次访问时懒启动，测试可直接构造 `JobScheduler` 并注入 `now`。
 *
 * 结束条件：
 * - `until`：当前时刻晚于 until → 不再触发
 * - `count`：已执行次数（lastRuns 里 ok/error）达到 count → 不再触发
 *
 * 宽限窗口：到点时刻 <= now 且 `now - 到点时刻 <= runtime.graceSeconds` → 补跑；
 * 超出窗口 → 记一条 `skipped`（记录决定），并把 nextRunAt 推进到下一周期。
 */
import { appendJobRun, patchJob, readJobs } from "./store.js";
import { runJobNow, type JobDeliverer, type JobExecutor } from "./runner.js";
import { cronNext } from "./cron.js";
import type { JobRunStatus, JobSpec } from "./types.js";

export type TickAction =
  | "ran"
  | "skipped"
  | "not-due"
  | "disabled"
  | "ended"
  | "running";

export interface TickEntry {
  jobId: string;
  action: TickAction;
  status?: JobRunStatus;
  message?: string;
}

export interface TickResult {
  at: string;
  entries: TickEntry[];
}

export interface SchedulerOptions {
  workspace: string;
  executor?: JobExecutor;
  deliverer?: JobDeliverer;
  /** 可注入的时钟（测试用假时钟） */
  now?: () => Date;
  logger?: (msg: string) => void;
}

type DueDecision =
  | { kind: "not-due"; nextRunAt: string | null }
  | { kind: "run"; nextRunAt: string | null; reason: "schedule" | "catchup" }
  | { kind: "missed"; nextRunAt: string | null; message: string }
  | { kind: "ended"; message: string };

function executionCount(job: JobSpec): number {
  return (job.lastRuns ?? []).filter((r) => r.status === "ok" || r.status === "error").length;
}

function decisionCount(job: JobSpec): number {
  return (job.lastRuns ?? []).filter((r) => r.status === "skipped").length;
}

export class JobScheduler {
  private readonly workspace: string;
  private readonly executor?: JobExecutor;
  private readonly deliverer?: JobDeliverer;
  private readonly clock: () => Date;
  private readonly logger: (msg: string) => void;
  private readonly running = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.workspace = options.workspace;
    this.executor = options.executor;
    this.deliverer = options.deliverer;
    this.clock = options.now ?? (() => new Date());
    this.logger = options.logger ?? (() => undefined);
  }

  /** 跑一轮调度；`at` 可显式传入（测试假时钟） */
  async tick(at: Date = this.clock()): Promise<TickResult> {
    const snapshot = await readJobs(this.workspace);
    const entries: TickEntry[] = [];
    for (const job of snapshot.file.jobs) {
      entries.push(await this.processJob(job, at));
    }
    return { at: at.toISOString(), entries };
  }

  private async processJob(job: JobSpec, at: Date): Promise<TickEntry> {
    if (!job.enabled) return { jobId: job.id, action: "disabled" };

    const endMessage = this.endReason(job, at);
    if (endMessage) {
      if (job.nextRunAt !== null) await patchJob(this.workspace, job.id, { nextRunAt: null });
      return { jobId: job.id, action: "ended", message: endMessage };
    }

    if (this.running.has(job.id)) return { jobId: job.id, action: "running" };

    const decision = this.decide(job, at);
    if (decision.kind === "not-due") {
      if (decision.nextRunAt !== job.nextRunAt) {
        await patchJob(this.workspace, job.id, { nextRunAt: decision.nextRunAt });
      }
      return { jobId: job.id, action: "not-due", message: decision.nextRunAt ?? undefined };
    }
    if (decision.kind === "ended") {
      if (job.nextRunAt !== null) await patchJob(this.workspace, job.id, { nextRunAt: null });
      return { jobId: job.id, action: "ended", message: decision.message };
    }
    if (decision.kind === "missed") {
      await appendJobRun(
        this.workspace,
        job.id,
        { at: at.toISOString(), status: "skipped", message: decision.message },
        { nextRunAt: decision.nextRunAt },
      );
      this.logger(`[jobs] ${job.name}: ${decision.message}`);
      return { jobId: job.id, action: "skipped", status: "skipped", message: decision.message };
    }

    // decision.kind === "run"
    this.running.add(job.id);
    try {
      const outcome = await runJobNow({
        workspace: this.workspace,
        job,
        now: at,
        ...(this.executor ? { executor: this.executor } : {}),
        ...(this.deliverer ? { deliverer: this.deliverer } : {}),
        reason: decision.reason,
        ...(decision.reason === "catchup"
          ? { note: `错过触发（在宽限窗口 ${job.runtime.graceSeconds}s 内），已补跑（记录该决定）` }
          : {}),
        nextRunAt: decision.nextRunAt,
      });
      return {
        jobId: job.id,
        action: "ran",
        status: outcome.status,
        message: outcome.message,
      };
    } finally {
      this.running.delete(job.id);
    }
  }

  /** 结束条件是否已满足；返回可读原因 */
  private endReason(job: JobSpec, at: Date): string | null {
    const end = job.schedule.end;
    if (!end || end.kind === "never") return null;
    if (end.kind === "until" && end.until) {
      const until = Date.parse(end.until);
      if (!Number.isNaN(until) && at.getTime() > until) {
        return `已到截止时间 ${end.until}，不再触发`;
      }
    }
    if (end.kind === "count" && typeof end.count === "number") {
      if (executionCount(job) >= end.count) {
        return `已完成 ${end.count} 次执行，不再触发`;
      }
    }
    return null;
  }

  private decide(job: JobSpec, at: Date): DueDecision {
    const nowMs = at.getTime();
    const graceMs = Math.max(0, job.runtime.graceSeconds) * 1000;

    if (job.schedule.kind === "once") {
      // 一次性任务最多执行一次；已经执行 / 已经决定过（skipped）就不再处理
      if (executionCount(job) > 0 || decisionCount(job) > 0) {
        return { kind: "ended", message: "一次性任务已执行" };
      }
      const atMs = Date.parse(job.schedule.at ?? "");
      if (Number.isNaN(atMs)) {
        return { kind: "ended", message: "一次性任务的 at 非法，已跳过" };
      }
      if (atMs > nowMs) return { kind: "not-due", nextRunAt: new Date(atMs).toISOString() };
      const delta = nowMs - atMs;
      if (delta <= graceMs) {
        return { kind: "run", nextRunAt: null, reason: delta > 0 ? "catchup" : "schedule" };
      }
      return {
        kind: "missed",
        nextRunAt: null,
        message: `错过触发（已晚 ${Math.round(delta / 1000)}s，超出宽限窗口 ${job.runtime.graceSeconds}s），不补跑（记录该决定）`,
      };
    }

    // periodic
    const cron = job.schedule.cron;
    if (!cron) return { kind: "ended", message: "周期任务缺少 cron，已跳过" };

    let nextMs: number;
    if (typeof job.nextRunAt === "string" && !Number.isNaN(Date.parse(job.nextRunAt))) {
      nextMs = Date.parse(job.nextRunAt);
    } else {
      const computed = cronNext(cron, job.schedule.timezone, at);
      return { kind: "not-due", nextRunAt: computed ? computed.toISOString() : null };
    }

    if (nextMs > nowMs) return { kind: "not-due", nextRunAt: new Date(nextMs).toISOString() };

    const delta = nowMs - nextMs;
    const advance = cronNext(cron, job.schedule.timezone, new Date(Math.max(nowMs, nextMs + 1)))?.toISOString() ?? null;
    if (delta <= graceMs) {
      return { kind: "run", nextRunAt: advance, reason: delta > 0 ? "catchup" : "schedule" };
    }
    return {
      kind: "missed",
      nextRunAt: advance,
      message: `错过触发（已晚 ${Math.round(delta / 1000)}s，超出宽限窗口 ${job.runtime.graceSeconds}s），不补跑（记录该决定）`,
    };
  }
}

// —— 进程内注册表：HTTP 层首次访问工作区时懒启动，一个定时器 tick 所有已知工作区 ——

const schedulers = new Map<string, JobScheduler>();
let timer: ReturnType<typeof setInterval> | null = null;

/** 注册并返回某工作区的调度器（重复调用返回同一个） */
export function getScheduler(workspace: string): JobScheduler {
  const existing = schedulers.get(workspace);
  if (existing) return existing;
  const scheduler = new JobScheduler({ workspace });
  schedulers.set(workspace, scheduler);
  return scheduler;
}

/**
 * 懒启动后台调度循环（60s 一轮）。测试可设 `OPEN_ASSISTANT_DISABLE_JOBS_SCHEDULER=1` 关闭。
 */
export function ensureSchedulerStarted(workspace: string): void {
  getScheduler(workspace);
  if (process.env.OPEN_ASSISTANT_DISABLE_JOBS_SCHEDULER === "1") return;
  if (timer) return;
  timer = setInterval(() => {
    for (const scheduler of schedulers.values()) {
      void scheduler.tick().catch((err) => {
        console.error(`[jobs] 调度轮次失败：${(err as Error).message}`);
      });
    }
  }, 60_000);
  // 后台循环不应阻止进程退出
  timer.unref?.();
}

/** 测试收尾用：停止定时器并清空注册表 */
export function resetSchedulers(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  schedulers.clear();
}