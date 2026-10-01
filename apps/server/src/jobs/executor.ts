/**
 * 任务执行器：把一条任务变成一段结果文本。
 *
 * - 固定文本任务（`content.kind === "text"`）：直接返回文本，**不启动 agent**
 *   （specs/agent-scheduling「文本任务」）。
 * - agent 任务：在**该工作区当前绑定的 agent** 上执行（身份不来自任务本身），
 *   走与普通对话同一条 `src/agent.ts` 图，因此人设 / 记忆 / 工具白名单都按绑定生效。
 *
 * 心跳任务（heartbeat）把 `<agents 根>/<agent-id>/HEARTBEAT.md` 当成本轮请求
 * （design D11：heartbeat 是把 HEARTBEAT.md 当 query 的定时任务，文件属于 agent）。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { JobError } from "./types.js";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./runner.js";

export const AGENT_HEARTBEAT_FILE = "HEARTBEAT.md";

/** 读取 agent 的心跳文件；不存在 → 抛可读错误（不静默当空请求） */
export async function readHeartbeatFile(agentDir: string): Promise<string> {
  const file = path.join(path.resolve(agentDir), AGENT_HEARTBEAT_FILE);
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new JobError(
        "JOB_INVALID_INPUT",
        `心跳任务缺少心跳文件：${file}（请在 agent 目录下创建 ${AGENT_HEARTBEAT_FILE}）`,
        400,
        "heartbeat",
      );
    }
    throw err;
  }
}

function extractAssistantText(result: unknown): string {
  const messages = (result as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { type?: string; getType?: () => string; content?: unknown } | undefined;
    const type = message?.getType?.() ?? message?.type;
    if (type !== "ai") continue;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          const text = (part as { text?: unknown } | null)?.text;
          return typeof text === "string" ? text : "";
        })
        .join("");
    }
    return "";
  }
  return "";
}

/**
 * 默认执行器。agent 任务才真正调用图；文本任务不会走到这里（runner 直接返回文本）。
 * 动态 import `../agent.js` 是为了让不碰模型的测试 / 校验代码不必加载模型配置。
 *
 * 注意：`../agent.js` 导出的是**工厂函数**（每次 run 用当次 config 求值一次，
 * 团队声明因此能在改完后生效；见 `src/agent.ts` 文件头）。所以这里必须先建图再 invoke。
 */
export const defaultJobExecutor: JobExecutor = async (
  ctx: JobExecutionContext,
): Promise<JobExecutionResult> => {
  const { agent } = await import("../agent.js");
  const config = { configurable: { workspace: ctx.workspace } };
  const graph = await agent(config);
  const result = await graph.invoke({ messages: [{ role: "user", content: ctx.prompt }] }, config);
  return { content: extractAssistantText(result) };
};