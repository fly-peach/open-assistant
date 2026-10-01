/**
 * 智能体标识校验与配置归一化（纯函数，便于测试）。
 *
 * 对齐 specs/agent-registry：
 * - 拒绝路径分隔符、`..`、空白；
 * - 缺字段用默认值（不因缺字段拒绝加载）；
 * - 非法取值要能被指出（这里只做前端可读校验，权威判定在后端）。
 */
import type { AgentConfig, AgentSummary, WorkspaceBindingRecord } from "@/lib/agentsApi";
export type AgentIdError =
  | "empty"
  | "separator"
  | "dotdot"
  | "whitespace"
  | "charset"
  | null;

/** 允许字母、数字、`-`、`_`，且必须以字母或数字开头。 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateAgentId(raw: string): AgentIdError {
  const id = raw.trim();
  if (!id) return "empty";
  if (/[/\\]/.test(id)) return "separator";
  if (id.includes("..")) return "dotdot";
  if (/\s/.test(id)) return "whitespace";
  if (!AGENT_ID_PATTERN.test(id)) return "charset";
  return null;
}

/**
 * 工具白名单的组。
 *
 * 以后端 `config.json` 的 `tools` 形状为准（布尔映射）：
 * `{ files, todos, persona, memory, delegation, crossAgent, peers }`
 * （见 `apps/server/src/agents/config.ts` 的 `TOOL_GROUPS`）。
 */
export const TOOL_GROUPS = [
  "files",
  "todos",
  "persona",
  "memory",
  "delegation",
  "crossAgent",
  "peers",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** 审批级别（后端的唯一合法集合，超范围会被拒绝加载）。 */
export const APPROVAL_LEVELS = ["auto", "confirm", "strict"] as const;

/**
 * 配置里的工具开关（布尔映射）。
 * 兼容读取历史 / 其他形状（`{ allow: [] }`、`string[]`），但**写回时按布尔映射**。
 */
export function configToolState(
  config: AgentConfig | undefined | null
): Record<string, boolean> {
  const tools = config?.tools;
  if (Array.isArray(tools)) {
    const map: Record<string, boolean> = {};
    TOOL_GROUPS.forEach((group) => (map[group] = tools.includes(group)));
    return map;
  }
  if (tools && typeof tools === "object") {
    const record = tools as Record<string, unknown>;
    if (Array.isArray(record.allow)) {
      const allow = record.allow as string[];
      const map: Record<string, boolean> = {};
      Object.keys(record).forEach((key) => {
        if (typeof record[key] === "boolean") map[key] = record[key] as boolean;
      });
      TOOL_GROUPS.forEach((group) => (map[group] = allow.includes(group)));
      return map;
    }
    const map: Record<string, boolean> = {};
    Object.entries(record).forEach(([key, value]) => {
      if (typeof value === "boolean") map[key] = value;
    });
    return map;
  }
  return {};
}

/** 配置里已有的审批级别。 */
export function configApproval(config: AgentConfig | undefined | null): string {
  const value = config?.approval;
  return typeof value === "string" ? value : "";
}

/** 可选审批级别（合法集合 ∪ 当前值，保证当前值不被静默改写）。 */
export function approvalOptions(current: string): string[] {
  const options = new Set<string>(APPROVAL_LEVELS);
  if (current) options.add(current);
  return [...options];
}

/** 工具开关选项：已知组 ∪ 配置里出现的其他组（原样保留，不静默丢掉）。 */
export function toolOptions(state: Record<string, boolean>): string[] {
  const options = new Set<string>(TOOL_GROUPS);
  Object.keys(state).forEach((group) => options.add(group));
  return [...options];
}

/** 提交给后端的 tools：只带布尔值（未知组只藏不送，否则后端会拒绝加载）。 */
export function toolsPayload(state: Record<string, boolean>): Record<string, boolean> {
  const payload: Record<string, boolean> = {};
  Object.entries(state).forEach(([group, value]) => {
    if (typeof value === "boolean") payload[group] = value;
  });
  return payload;
}

/** 配置里的模型 id（后端 `model` 是 `{ id, providerId?, baseUrl? } | null`）。 */
export function configModelId(config: AgentConfig | undefined | null): string {
  const model = config?.model;
  if (model && typeof model === "object" && typeof model.id === "string") {
    return model.id;
  }
  return "";
}

/** 配置里的供应商标识（老配置可能没有 → 空串 = 让后端按 baseUrl/默认解析）。 */
export function configModelProviderId(config: AgentConfig | undefined | null): string {
  const model = config?.model;
  return model && typeof model.providerId === "string" ? model.providerId : "";
}

/** 下拉里的合成键 `providerId::modelId`（与 modelsApi.modelKey 一致）。 */
export function modelSelectValue(
  config: AgentConfig | undefined | null
): string {
  const id = configModelId(config);
  if (!id) return "";
  const providerId = configModelProviderId(config);
  return providerId ? `${providerId}::${id}` : id;
}

/**
 * 模型载荷：留空即 null（用全局默认），否则带上供应商。
 *
 * `providerId` 是关键：同名模型在不同供应商下指向不同端点
 * （比如 `deepseek-chat` 在 DeepSeek 官方和自建网关上都有），
 * 只存 id 会让解析链去猜。老配置没有这个字段时保持原样，由后端按 baseUrl 反查。
 */
export function modelPayload(
  id: string,
  config: AgentConfig | undefined | null
): { id: string; providerId?: string; baseUrl?: string } | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("::");
  if (separator > 0) {
    return { id: trimmed.slice(separator + 2), providerId: trimmed.slice(0, separator) };
  }
  const baseUrl = config?.model?.baseUrl;
  const providerId = configModelProviderId(config);
  return {
    id: trimmed,
    ...(providerId ? { providerId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** 可联系名单的文本 ↔ 数组转换（逗号 / 换行分隔）。 */
export function parseContacts(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function formatContacts(list: string[] | undefined): string {
  return (list ?? []).join(", ");
}

/* ------------------------------------------------------------------ 绑定 */

export type BindingState =
  | "no-workspace"
  | "loading"
  | "unknown"
  | "none"
  | "bound"
  | "missing-agent";

export interface BindingView {
  state: BindingState;
  agentId: string | null;
  agentName: string;
  /** 已加载到的智能体标识（用于判断绑定的 agent 是否还存在）。 */
  knownAgentIds: string[] | null;
}

export function deriveBindingState(
  binding: WorkspaceBindingRecord | null | undefined,
  knownAgentIds: string[] | null,
  error: unknown,
  hasWorkspace: boolean
): BindingView {
  if (!hasWorkspace) {
    return { state: "no-workspace", agentId: null, agentName: "", knownAgentIds };
  }
  if (error) {
    return { state: "unknown", agentId: null, agentName: "", knownAgentIds };
  }
  if (!binding) {
    return { state: "loading", agentId: null, agentName: "", knownAgentIds };
  }
  const agentId = binding.agentId ?? null;
  if (!agentId) {
    return { state: "none", agentId: null, agentName: "", knownAgentIds };
  }
  if (knownAgentIds && !knownAgentIds.includes(agentId)) {
    return { state: "missing-agent", agentId, agentName: agentId, knownAgentIds };
  }
  return {
    state: "bound",
    agentId,
    agentName: binding.agentName ?? agentId,
    knownAgentIds,
  };
}

/**
 * 未绑定时必须阻止发送（specs/agent-binding「未绑定则阻止」）。
 * 绑定状态**读不到**时不阻止：那是后端不可用，而不是「未绑定」，
 * 真正的一致性由后端在 run 入口强制校验（前端禁用只是体验）。
 */
export function canSendWithBinding(state: BindingState): boolean {
  return state !== "none" && state !== "missing-agent";
}

/** 短标识：uuid 前 8 位（会话列表 / 会话页的短 id 规则，design D5）。 */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}

/** 智能体列表里带异常标注的项按标识排序（列表稳定，便于断言）。 */
export function sortAgents(agents: AgentSummary[]): AgentSummary[] {
  return [...agents].sort((left, right) => left.id.localeCompare(right.id));
}