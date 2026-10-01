/**
 * 智能体选择器客户端（一个工作区 N 个 agent + 一个激活位）。
 *
 * - `GET    /workspace/agents?path=`         → 成员（含停用）+ 候选 + 激活位
 * - `PUT    /workspace/agents/{id}?path=`    → 加成员 / 改启用 / 切激活（可一次做完）
 * - `DELETE /workspace/agents/{id}?path=`    → 从工作区移除
 * - `PUT    /agents/{id}/pinned`             → 置顶（agent 自己的全局偏好）
 *
 * 后端的两条不变式（见 apps/server/src/binding.ts）：默认 agent 不可停用/移除；
 * 停用或移除激活位时自动回落默认 agent —— 所以这边拿到的 `activeAgentId` 永远是有效的。
 */
import { request } from "@/lib/workspaceApi";

export type AgentStartupStatus = "disabled" | "failed" | "running";

export interface WorkspaceAgentEntry {
  id: string;
  name: string;
  description?: string;
  /** 在**这个工作区**里启用了吗 */
  enabled: boolean;
  /** 是当前激活的那个吗 */
  active: boolean;
  /** agent 自己的全局偏好 */
  pinned: boolean;
  availableInChat: boolean;
  startupStatus: AgentStartupStatus;
  valid: boolean;
  issues?: string[];
}

export interface WorkspaceAgentsView {
  workspace: string;
  activeAgentId: string;
  members: WorkspaceAgentEntry[];
  candidates: WorkspaceAgentEntry[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeEntry(raw: unknown): WorkspaceAgentEntry | null {
  const rec = asRecord(raw);
  const id = typeof rec["id"] === "string" ? rec["id"] : null;
  if (!id) return null;
  const status = rec["startupStatus"];
  const entry: WorkspaceAgentEntry = {
    id,
    name: typeof rec["name"] === "string" ? rec["name"] : id,
    enabled: rec["enabled"] === true,
    active: rec["active"] === true,
    pinned: rec["pinned"] === true,
    availableInChat: rec["availableInChat"] !== false,
    startupStatus:
      status === "disabled" || status === "failed" || status === "running" ? status : "failed",
    valid: rec["valid"] !== false,
  };
  if (typeof rec["description"] === "string" && rec["description"].length > 0) {
    entry.description = rec["description"];
  }
  if (Array.isArray(rec["issues"])) {
    const issues = (rec["issues"] as unknown[]).filter((i): i is string => typeof i === "string");
    if (issues.length > 0) entry.issues = issues;
  }
  return entry;
}

function normalizeView(raw: unknown, fallbackWorkspace: string): WorkspaceAgentsView {
  const rec = asRecord(raw);
  const list = (value: unknown): WorkspaceAgentEntry[] =>
    Array.isArray(value)
      ? (value.map(normalizeEntry).filter((e) => e !== null) as WorkspaceAgentEntry[])
      : [];
  return {
    workspace: typeof rec["workspace"] === "string" ? rec["workspace"] : fallbackWorkspace,
    activeAgentId: typeof rec["activeAgentId"] === "string" ? rec["activeAgentId"] : "",
    members: list(rec["members"]),
    candidates: list(rec["candidates"]),
  };
}

export async function getWorkspaceAgents(workspace: string): Promise<WorkspaceAgentsView> {
  const raw = await request<unknown>(`/workspace/agents?path=${encodeURIComponent(workspace)}`);
  return normalizeView(raw, workspace);
}

export async function updateWorkspaceAgent(
  workspace: string,
  id: string,
  patch: { enabled?: boolean; active?: boolean; add?: boolean },
): Promise<WorkspaceAgentsView> {
  const raw = await request<unknown>(
    `/workspace/agents/${encodeURIComponent(id)}?path=${encodeURIComponent(workspace)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
  return normalizeView(raw, workspace);
}

export async function removeWorkspaceAgent(
  workspace: string,
  id: string,
): Promise<WorkspaceAgentsView> {
  const raw = await request<unknown>(
    `/workspace/agents/${encodeURIComponent(id)}?path=${encodeURIComponent(workspace)}`,
    { method: "DELETE" },
  );
  return normalizeView(raw, workspace);
}

export async function setAgentPinned(id: string, pinned: boolean): Promise<void> {
  await request<unknown>(`/agents/${encodeURIComponent(id)}/pinned`, {
    method: "PUT",
    body: JSON.stringify({ pinned }),
  });
}