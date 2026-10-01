/**
 * 智能体档案客户端（选择器 + 配置页用）。
 *
 * 模型（照 QwenPaw 的 `AgentProfileRef { id, workspace_dir, enabled, pinned }`）：
 * **每个 agent 有自己的工作区目录，agent ↔ 目录是 1:1**。
 * 选择器列的是这份名单；选一个 = 切到它维护的那个工作区（连带切 agent）。
 *
 * - `GET /agent-profiles?workspace=`     → 全部 agent + 各自目录 + 当前工作区用的是谁
 * - `PUT /agents/{id}/workspace`         → 指定 / 解除工作区目录（1:1 冲突 → 409）
 * - `PUT /agents/{id}/enabled`           → 启用 / 停用（默认 agent 不可停用）
 * - `PUT /agents/{id}/pinned`            → 置顶
 */
import { request } from "@/lib/workspaceApi";

export type AgentStartupStatus = "disabled" | "failed" | "running";

export interface AgentProfileEntry {
  id: string;
  name: string;
  description?: string;
  /** 这个 agent 维护的目录；null = 还没指定（能看见但切不过去） */
  workspaceDir: string | null;
  enabled: boolean;
  pinned: boolean;
  availableInChat: boolean;
  startupStatus: AgentStartupStatus;
  valid: boolean;
  issues?: string[];
  active: boolean;
  /** 是不是主智能体（生活管家；不可删除） */
  main: boolean;
}

export interface AgentProfilesView {
  currentWorkspace: string;
  activeAgentId: string | null;
  agents: AgentProfileEntry[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeEntry(raw: unknown): AgentProfileEntry | null {
  const rec = asRecord(raw);
  const id = typeof rec["id"] === "string" ? rec["id"] : null;
  if (!id) return null;
  const status = rec["startupStatus"];
  const entry: AgentProfileEntry = {
    id,
    name: typeof rec["name"] === "string" ? rec["name"] : id,
    workspaceDir: typeof rec["workspaceDir"] === "string" ? rec["workspaceDir"] : null,
    enabled: rec["enabled"] !== false,
    pinned: rec["pinned"] === true,
    availableInChat: rec["availableInChat"] !== false,
    startupStatus:
      status === "disabled" || status === "failed" || status === "running" ? status : "failed",
    valid: rec["valid"] !== false,
    active: rec["active"] === true,
    main: rec["main"] === true,
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

export async function getAgentProfiles(workspace: string | null): Promise<AgentProfilesView> {
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const raw = await request<unknown>(`/agent-profiles${query}`);
  const rec = asRecord(raw);
  return {
    currentWorkspace: typeof rec["currentWorkspace"] === "string" ? rec["currentWorkspace"] : "",
    activeAgentId: typeof rec["activeAgentId"] === "string" ? rec["activeAgentId"] : null,
    agents: Array.isArray(rec["agents"])
      ? (rec["agents"].map(normalizeEntry).filter((e) => e !== null) as AgentProfileEntry[])
      : [],
  };
}

/**
 * 把某个工作区目录绑定给某 agent（`PUT /workspace/binding`）。
 * 切换 agent 时必须连带做这一步：否则切过去的目录是「未绑定」状态，对话会被拦。
 */
export async function bindWorkspace(path: string, agentId: string): Promise<void> {
  await request<unknown>("/workspace/binding", {
    method: "PUT",
    body: JSON.stringify({ path, agentId, mode: "keep" }),
  });
}

export async function setAgentWorkspaceDir(id: string, workspaceDir: string | null): Promise<void> {
  await request<unknown>(`/agents/${encodeURIComponent(id)}/workspace`, {
    method: "PUT",
    body: JSON.stringify({ workspaceDir }),
  });
}

export async function setAgentEnabled(id: string, enabled: boolean): Promise<void> {
  await request<unknown>(`/agents/${encodeURIComponent(id)}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function setAgentPinned(id: string, pinned: boolean): Promise<void> {
  await request<unknown>(`/agents/${encodeURIComponent(id)}/pinned`, {
    method: "PUT",
    body: JSON.stringify({ pinned }),
  });
}

/**
 * 能不能切过去。返回原因码（`null` = 能切）。
 * 与后端 `switchBlockReason` 同一套语义，界面据此给一句话而不是干瞪眼。
 */
export function switchBlockReason(entry: AgentProfileEntry): "disabled" | "invalid" | "no-workspace" | null {
  if (!entry.enabled) return "disabled";
  if (!entry.valid) return "invalid";
  if (!entry.workspaceDir) return "no-workspace";
  return null;
}