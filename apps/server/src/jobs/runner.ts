/**
 * 单次任务执行编排：解析触发身份 → 执行 → 记录 lastRuns → 投递到本工作区会话。
 *
 * 对齐 specs/agent-scheduling：
 * - 触发身份 = 工作区当前绑定的 agent（任务不另存 agent 配置；换绑后按新身份执行）
 * - 每次执行追加一条 lastRuns（时刻 + 状态 + 失败原因）
 * - 失败不静默（记录 + 控制台错误 + 非静默任务时投递失败到会话）
 * - 文本任务直接投递文本，不启动 agent
 *
 * executor / deliverer 可注入，便于测试不依赖真实模型；生产走默认实现。
 */
import { readBinding } from "../binding.js";
import { resolveAgentRuntime } from "../agents/registry.js";
import { JobError, type JobRunStatus, type JobSpec } from "./types.js";
import { appendJobRun } from "./store.js";
import { defaultJobExecutor, readHeartbeatFile } from "./executor.js";
import { deliverToWorkspaceSession } from "./session.js";

export interface JobExecutionContext {
  workspace: string;
  job: JobSpec;
  /** 触发身份：当前绑定 agent（文本任务可为 null） */
  agentId: string | null;
  /** 交给 agent / 投递的请求文本 */
  prompt: string;
  now: Date;
}

export interface JobExecutionResult {
  content: string;
}

export type JobExecutor = (ctx: JobExecutionContext) => Promise<JobExecutionResult>;

export interface DeliveryContext {
  workspace: string;
  job: JobSpec;
  agentId: string | null;
  prompt: string;
  content: string;
  /** 只可能是 ok / error（skipped 不触发执行） */
  status: Extract<JobRunStatus, "ok" | "error">;
  runAt: string;
}

export type JobDeliverer = (ctx: DeliveryContext) => Promise<{ threadId?: string }>;

/** 进程级默认执行器覆盖（测试 / 探针注入确定性执行器，不依赖真实模型） */
let injectedExecutor: JobExecutor | null = null;

/** 设置默认执行器；传 null 恢复真实 agent 执行器 */
export function setDefaultJobExecutor(fn: JobExecutor | null): void {
  injectedExecutor = fn;
}

export interface RunJobOptions {
  workspace: string;
  job: JobSpec;
  now?: Date;
  executor?: JobExecutor;
  deliverer?: JobDeliverer;
  reason?: "manual" | "schedule" | "catchup";
  /** 调度器给的说明（如补跑决定），与失败原因一起记进 lastRuns.message */
  note?: string;
  /** 调度器在本次执行后写入的 nextRunAt（手动触发不传） */
  nextRunAt?: string | null;
}

export interface RunJobOutcome {
  status: Extract<JobRunStatus, "ok" | "error">;
  message?: string;
  content: string;
  agentId: string | null;
  delivered: boolean;
  threadId?: string;
  runAt: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JobError("JOB_INVALID_INPUT", `${label} 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 解析该工作区当前绑定的 agent；未绑定 / 损坏 → 返回 null 与错误说明 */
async function resolveAgentId(
  workspace: string,
): Promise<{ agentId: string | null; error?: string }> {
  try {
    const binding = await readBinding(workspace);
    if (!binding) return { agentId: null, error: "工作区尚未绑定 agent" };
    return { agentId: binding.activeAgentId };
  } catch (err) {
    return { agentId: null, error: `读取工作区绑定失败：${(err as Error).message}` };
  }
}

async function buildPrompt(
  workspace: string,
  job: JobSpec,
  agentId: string | null,
): Promise<string> {
  if (job.content.kind === "text") return job.content.text;
  if (job.heartbeat) {
    if (!agentId) {
      throw new JobError("JOB_INVALID_INPUT", "心跳任务需要工作区绑定 agent（心跳文件属于 agent）", 400, "heartbeat");
    }
    const runtime = await resolveAgentRuntime(agentId);
    return readHeartbeatFile(runtime.dir);
  }
  return job.content.text;
}

/**
 * 执行一条任务并落库 / 投递。不决定「是否到点」——那是调度器的职责。
 */
export async function runJobNow(options: RunJobOptions): Promise<RunJobOutcome> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString();
  const executor = options.executor ?? injectedExecutor ?? defaultJobExecutor;
  const deliverer = options.deliverer ?? deliverToWorkspaceSession;

  const { agentId, error: bindingError } = await resolveAgentId(options.workspace);
  let prompt = options.job.content.text;
  let status: Extract<JobRunStatus, "ok" | "error"> = "ok";
  let content = "";
  let message: string | undefined;

  try {
    prompt = await buildPrompt(options.workspace, options.job, agentId);
    if (options.job.content.kind === "text") {
      // 固定文本任务：直接投递文本，不启动 agent
      content = options.job.content.text;
    } else if (!agentId) {
      throw new JobError(
        "JOB_INVALID_INPUT",
        `无法执行 agent 任务：${bindingError ?? "工作区未绑定 agent"}`,
        400,
        "agentId",
      );
    } else {
      const result = await withTimeout(
        executor({ workspace: options.workspace, job: options.job, agentId, prompt, now }),
        options.job.runtime.timeoutSeconds * 1000,
        `任务 ${options.job.name}`,
      );
      content = result.content;
    }
  } catch (err) {
    status = "error";
    message = (err as Error).message;
    content = `执行失败：${message}`;
    // 失败不静默：即使界面只读 lastRuns，控制台也要留下可检索的一行
    console.error(`[jobs] 任务 ${options.job.id}（${options.job.name}）执行失败：${message}`);
  }

  let delivered = false;
  let threadId: string | undefined;
  const saveResult = options.job.meta?.saveResult !== false;
  if (saveResult && !options.job.silent) {
    try {
      const result = await deliverer({
        workspace: options.workspace,
        job: options.job,
        agentId,
        prompt,
        content,
        status,
        runAt,
      });
      threadId = result.threadId;
      delivered = true;
    } catch (err) {
      const deliveryError = (err as Error).message;
      message = message ? `${message}；投递失败：${deliveryError}` : `投递失败：${deliveryError}`;
      console.error(`[jobs] 任务 ${options.job.id} 结果投递失败：${deliveryError}`);
    }
  }

  const finalMessage =
    [options.note, message].filter((part): part is string => typeof part === "string" && part.length > 0).join("；") || undefined;
  await appendJobRun(
    options.workspace,
    options.job.id,
    { at: runAt, status, ...(finalMessage ? { message: finalMessage } : {}) },
    {
      ...(options.nextRunAt !== undefined ? { nextRunAt: options.nextRunAt } : {}),
      ...(threadId ? { threadId } : {}),
    },
  );

  return {
    status,
    ...(finalMessage ? { message: finalMessage } : {}),
    content,
    agentId,
    delivered,
    ...(threadId ? { threadId } : {}),
    runAt,
  };
}