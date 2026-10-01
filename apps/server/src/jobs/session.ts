/**
 * 任务结果投递：写进**本工作区的会话记录**（design D4 的 conversation store，
 * `<工作区>/.open-assistant/sessions.sqlite`，thread / turn / message 三层）。
 *
 * 对齐 specs/agent-scheduling「结果可在会话中查看」：
 * - 每个任务复用同一个会话（threadId 落回 jobs.json 的 `threadId`），多次触发都追加在同一会话里；
 * - 结果以一条 ai 文本消息落库，用户可在会话里回看；
 * - 失败也会落一条 error 轮次，保证「失败不静默」。
 *
 * 说明：我们无 channel 概念，`dispatch.mode` 只保留字段；这里统一投递“最终结果”
 * （stream 的过程分片由真实 runtime 在后续接线时补齐，不影响会话可回看）。
 */
import type { JobRunStatus, JobSpec } from "./types.js";
import type { DeliveryContext, JobDeliverer } from "./runner.js";

/** 结果在会话里的用户侧输入（便于在会话列表里一眼看出这是任务投递） */
function userContentFor(ctx: DeliveryContext): string {
  const label = ctx.job.heartbeat ? "心跳任务" : "定时任务";
  return `[${label}] ${ctx.job.name}`;
}

export const deliverToWorkspaceSession: JobDeliverer = async (
  ctx: DeliveryContext,
): Promise<{ threadId?: string }> => {
  // 动态 import：不碰 SQLite 的调用方（校验 / 纯 JSON 单测）不必加载 node:sqlite
  const { createThread, recordTurn, threadExists } = await import("../conversation/index.js");
  const agentId = ctx.agentId ?? "unknown";
  let threadId = ctx.job.threadId;
  if (!threadId || !threadExists(ctx.workspace, threadId)) {
    const thread = createThread(ctx.workspace, {
      agentId,
      kind: "main",
      title: `定时任务：${ctx.job.name}`,
      meta: { jobId: ctx.job.id, source: "job" },
    });
    threadId = thread.id;
  }

  const status: "done" | "error" = ctx.status === "error" ? "error" : "done";
  recordTurn(ctx.workspace, {
    threadId,
    userContent: userContentFor(ctx),
    messages: [{ role: "ai", kind: "text", content: ctx.content }],
    status,
  });
  return { threadId };
};

/** 结果状态（供上层记录）：投递本身不改变执行状态 */
export type { JobRunStatus, JobSpec };