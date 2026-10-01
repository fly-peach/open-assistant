/**
 * 会话库客户端：对齐后端 `GET /workspace/sessions`（见 apps/server/src/conversation/session-list.ts）。
 *
 * 会话列表的**记录来源是工作区会话库**；平台只提供热会话的实时状态（`liveStatus`）
 * 与未落库历史 thread 的导入。因此列表在「工作区 / agent / 会话」三层身份下是稳定的，
 * 不依赖执行引擎侧的状态。
 */
import { request } from "@/lib/workspaceApi";

/** 平台实时状态（热会话才有） */
export type LiveStatus = "idle" | "busy" | "interrupted" | "error";

/** 会话库里的会话状态（记录口径，不等于实时状态） */
export type SessionStatus = "active" | "archived" | "error";

export interface WorkspaceSession {
  id: string;
  agentId: string;
  kind: "main" | "subagent" | "agent-call";
  title: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  messageCount: number;
  /** 未正常结束的轮次数（running / cancelled / error） */
  unfinishedTurnCount: number;
  lastActivityAt: string;
  /** 平台实时状态；纯冷会话为 null */
  liveStatus: LiveStatus | null;
}

/** 列出某工作区的会话（含非活跃，按最近活动倒序） */
export async function listWorkspaceSessions(
  workspacePath: string,
  options: { limit?: number; offset?: number } = {}
): Promise<WorkspaceSession[]> {
  const params = new URLSearchParams({ path: workspacePath });
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const data = await request<{ sessions: WorkspaceSession[] }>(
    `/workspace/sessions?${params.toString()}`
  );
  return data.sessions ?? [];
}

function sessionPath(workspacePath: string, sessionId: string): string {
  return `/workspace/sessions/${encodeURIComponent(sessionId)}?${new URLSearchParams({
    path: workspacePath,
  }).toString()}`;
}

/** 重命名会话（`title` 传 null / 空串表示清空，回到默认标题） */
export async function renameWorkspaceSession(
  workspacePath: string,
  sessionId: string,
  title: string | null
): Promise<WorkspaceSession | null> {
  const data = await request<{ thread: WorkspaceSession | null }>(
    sessionPath(workspacePath, sessionId),
    { method: "PATCH", body: JSON.stringify({ title }) }
  );
  return data.thread ?? null;
}

/** 删除会话（默认连带子会话） */
export async function deleteWorkspaceSession(
  workspacePath: string,
  sessionId: string
): Promise<void> {
  await request(sessionPath(workspacePath, sessionId), { method: "DELETE" });
}