/**
 * 把「一轮对话」落进工作区会话库（`<工作区>/.open-assistant/sessions.sqlite`）。
 *
 * 这是会话库「上岗」的写入口：`workspaceMiddleware.afterAgent` 在一轮结束时调用它，
 * 使「一轮结束 → 内容已落工作区库」成立（对齐 spec `session-store` 的「写入即时落盘」）。
 *
 * 幂等：同一轮（同一个 `turnId`）重复调用会整体替换，重放 / afterAgent 多次触发都安全。
 * 失败向上抛，由调用方（middleware）决定是否 best-effort 吞掉。
 */
import type { BaseMessage } from "@langchain/core/messages";

import { sliceLastTurn } from "./message-slice.js";
import { type CompactionConfig, compactThreadIfNeeded } from "./compaction.js";
import { createThread, threadExists, upsertRecordedTurn } from "./store.js";

export interface RecordTurnToWorkspaceOptions {
  /** 会话标识（= 平台 thread_id） */
  threadId: string;
  /** 记录创建时所属 agent（工作区绑定 / 历史归属） */
  agentId: string;
  /** 本轮结束时的完整消息序列 */
  messages: BaseMessage[];
  /** 压缩配置（阈值 / 保留窗口）；省略则读环境变量（`OPEN_ASSISTANT_COMPACT_*`） */
  compaction?: CompactionConfig;
}

/**
 * 记录「最后一轮」。返回是否写入（没有用户消息可切时返回 false）。
 * 会话不存在时先建会话行（agentId 用于归属）。
 */
export function recordTurnToWorkspace(
  workspaceDir: string,
  options: RecordTurnToWorkspaceOptions,
): boolean {
  const slice = sliceLastTurn(options.messages);
  if (!slice) return false;
  if (!threadExists(workspaceDir, options.threadId)) {
    createThread(workspaceDir, {
      id: options.threadId,
      agentId: options.agentId,
      kind: "main",
      title: null,
    });
  }
  upsertRecordedTurn(workspaceDir, {
    threadId: options.threadId,
    turnId: slice.turnId,
    userContent: slice.userContent,
    messages: slice.messages,
    status: "done",
  });
  // 库侧上下文压缩：未压缩轮次超过阈值时保留最近若干轮并生成摘要（阈值可配置）
  compactThreadIfNeeded(workspaceDir, options.threadId, options.compaction);
  return true;
}