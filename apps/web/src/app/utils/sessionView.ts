/**
 * 会话记录 → 会话列表项（纯函数）。
 *
 * 列表记录来自工作区会话库（`sessionsApi`），实时状态叠加自平台（`liveStatus`）。
 * 把「记录口径的状态」与「实时状态」的取舍集中在这里，便于单测。
 *
 * 状态优先级：`liveStatus`（热会话实时态）> 记录里的 error > 有未结束轮次（interrupted）> idle。
 * 这样既不丢热会话的 busy / interrupted，又能让冷会话给出合理状态。
 */
import type { Thread } from "@langchain/langgraph-sdk";

import type { WorkspaceSession } from "@/lib/sessionsApi";

export interface ThreadItem {
  id: string;
  updatedAt: Date;
  status: Thread["status"];
  title: string;
  description: string;
  assistantId?: string;
  /** 创建这条会话时的 agent（列表据此标注「由 xxx 创建」） */
  agentId?: string;
  agentName?: string;
}

/** 记录 + 实时状态 → 列表项状态 */
export function sessionThreadStatus(
  session: Pick<WorkspaceSession, "status" | "liveStatus" | "unfinishedTurnCount">
): Thread["status"] {
  if (session.liveStatus) return session.liveStatus;
  if (session.status === "error") return "error";
  if (session.unfinishedTurnCount > 0) return "interrupted";
  return "idle";
}

/** 一条会话记录 → 列表项（`untitled` 用于补可辨识的占位标题） */
export function sessionToThreadItem(session: WorkspaceSession, untitled: string): ThreadItem {
  return {
    id: session.id,
    updatedAt: new Date(session.updatedAt),
    status: sessionThreadStatus(session),
    title: session.title && session.title.length > 0 ? session.title : untitled,
    description: "",
    agentId: session.agentId,
  };
}