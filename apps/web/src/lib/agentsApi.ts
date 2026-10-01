/**
 * 智能体注册表 / 工作区绑定 / 记忆的 HTTP 客户端。
 *
 * 对齐 design.md D9 的「业务 API」分组（后端 `apps/server`）：
 * - `GET    /agents`                    → `{ root, agents: [...] }`
 * - `POST   /agents`                    → `{ id }`
 * - `GET    /agents/{id}`               → 定义详情（人设 / 配置 / 记忆 / 技能）
 * - `PATCH  /agents/{id}`               → 局部更新
 * - `DELETE /agents/{id}`               → `{ ok: true }`
 * - `GET/PUT /agents/{id}/memory`       → 长期记忆（跨工作区共享，核心 `MEMORY.md`）
 * - `GET    /agents/{id}/memory/tree`   → 分层记忆的扁平清单 `{ entries: [{ rel, type, size? }] }`
 * - `GET    /agents/{id}/memory/file?rel=` → 某个记忆文件 `{ rel, content }`
 * - `GET    /workspace/binding?path=`   → `{ agentId, agentName?, boundAt?, lastSwitch? }`
 * - `PUT    /workspace/binding`         → `{ path, agentId, mode: "keep" | "archive" }`
 * - `GET/PUT /memory/project?path=`     → 项目记忆（属于工作区）
 *
 * 后端尚未就绪时这些端点会 404 / 网络失败，客户端统一抛 `WorkspaceApiError`，
 * 页面据此展示可读的错误态（而不是静默成功）。
 */
import { getBaseUrl, request, WorkspaceApiError } from "@/lib/workspaceApi";

export { WorkspaceApiError };

/** 列表项里的模型摘要（`null` = 配置里没写 → 跟随全局默认）。 */
export interface AgentModelSummary {
  id: string;
  providerId?: string;
}

/** 列表里的一项：`valid=false` 表示人设或配置缺失（标注而不是整体失败）。 */
export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  /**
   * 该 agent 配置里显式指定的模型。
   * - 对象：这个 agent 用自己的模型（不同 agent 可以各配各的）；
   * - `null`：配置里没写，跟随全局默认；
   * - `undefined`：后端没给/读不出来，**不要**当成「跟随默认」展示。
   */
  model?: AgentModelSummary | null;
  valid: boolean;
  issues?: string[];
  /** 是否是主智能体（生活管家；不可删除） */
  main: boolean;
}

export interface AgentsRoot {
  root: string;
  agents: AgentSummary[];
}

/** 技能（渐进披露：只有名称与描述会随运行注入）。共享池 + 私有，同名私有优先。 */
export interface AgentSkill {
  name: string;
  description: string;
  /** 来源：agent 私有 / 共享池（继承） */
  source: "agent" | "shared";
  /** 该技能是否被本 agent 关闭 */
  disabled: boolean;
  /** agent 私有技能覆盖了同名共享技能 */
  overridesShared: boolean;
}

/** 智能体配置。字段以后端 `config.json` 为准（`apps/server/src/agents/config.ts`）。 */
export interface AgentModelConfig {
  id: string;
  /** 供应商标识（`models.json` 里的 id）；老配置可能没有，由后端按 baseUrl 反查 */
  providerId?: string;
  baseUrl?: string;
}

export interface AgentConfig {
  version?: number;
  name?: string;
  description?: string;
  model?: AgentModelConfig | null;
  /** 工具白名单：组 → 是否启用（布尔映射）。 */
  tools?: Record<string, boolean>;
  /** 被本 agent 关闭的技能名 */
  disabledSkills?: string[];
  approval?: string;
  allowSiblingInteraction?: boolean;
  contactableAgents?: string[];
  [key: string]: unknown;
}

export interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  config: AgentConfig;
  persona: string;
  memory: string;
  skills: AgentSkill[];
}

export interface WorkspaceBindingRecord {
  agentId: string | null;
  agentName?: string | null;
  boundAt?: string | null;
  lastSwitch?: { from?: string | null; at?: string | null; reason?: string | null } | null;
}

export type SwitchMode = "keep" | "archive";

/* ------------------------------------------------------------------ 归一化 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 列表项的模型字段：区分「后端明确说没有（null）」与「后端没给这个字段（undefined）」。
 * 后者按「未知」处理，前端不替它编一个「跟随全局默认」。
 */
function normalizeSummaryModel(
  value: unknown
): AgentModelSummary | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) return null;
  const providerId = asString(record.providerId);
  return providerId ? { id, providerId } : { id };
}

function normalizeSummary(raw: unknown): AgentSummary | null {
  const record = asRecord(raw);
  const id = asString(record.id);
  if (!id) return null;
  const summary: AgentSummary = {
    id,
    name: asString(record.name) ?? id,
    description: asString(record.description),
    valid: record.valid !== false,
    issues: asStringList(record.issues),
    main: record.main === true,
  };
  const model = normalizeSummaryModel(record.model);
  if (model !== undefined) summary.model = model;
  return summary;
}

export function normalizeAgentsRoot(raw: unknown): AgentsRoot {
  const record = asRecord(raw);
  const list = Array.isArray(raw) ? raw : record.agents;
  const agents = (Array.isArray(list) ? list : [])
    .map(normalizeSummary)
    .filter((item): item is AgentSummary => item !== null);
  return { root: asString(record.root) ?? "", agents };
}

export function normalizeAgentDetail(id: string, raw: unknown): AgentDetail {
  const record = asRecord(raw);
  return {
    id: asString(record.id) ?? id,
    name: asString(record.name) ?? id,
    description: asString(record.description),
    config: asRecord(record.config) as AgentConfig,
    persona: asString(record.persona) ?? "",
    memory: asString(record.memory) ?? "",
    skills: (Array.isArray(record.skills) ? record.skills : [])
      .map((item) => {
        const skill = asRecord(item);
        const name = asString(skill.name);
        if (!name) return null;
        return {
          name,
          description: asString(skill.description) ?? "",
          source: asString(skill.source) === "agent" ? "agent" : "shared",
          disabled: skill.disabled === true,
          overridesShared: skill.overridesShared === true,
        };
      })
      .filter((item): item is AgentSkill => item !== null),
  };
}

/**
 * 记忆端点的返回可能是 `{ content }` / `{ memory }` / 纯文本，统一收敛成字符串。
 * 后端未就绪时（404）由调用方处理错误。
 */
export function normalizeTextResult(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const record = asRecord(raw);
  for (const key of ["content", "memory", "text", "value"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function normalizeBinding(raw: unknown): WorkspaceBindingRecord {
  const record = asRecord(raw);
  const agentId = asString(record.agentId) ?? asString(record.agent_id) ?? null;
  const lastSwitchRaw = asRecord(record.lastSwitch);
  const lastSwitch = Object.keys(lastSwitchRaw).length
    ? {
        from: asString(lastSwitchRaw.from) ?? null,
        at: asString(lastSwitchRaw.at) ?? null,
        reason: asString(lastSwitchRaw.reason) ?? null,
      }
    : null;
  return {
    agentId,
    agentName: asString(record.agentName) ?? asString(record.agent_name) ?? null,
    boundAt: asString(record.boundAt) ?? null,
    lastSwitch,
  };
}

/* ------------------------------------------------------------------ 智能体 */

export function listAgents(): Promise<AgentsRoot> {
  return request<unknown>("/agents").then(normalizeAgentsRoot);
}

export function createAgent(body: {
  id: string;
  name?: string;
  description?: string;
}): Promise<{ id: string }> {
  return request<{ id: string }>("/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getAgent(id: string): Promise<AgentDetail> {
  return request<unknown>(`/agents/${encodeURIComponent(id)}`).then((raw) =>
    normalizeAgentDetail(id, raw)
  );
}

export function updateAgent(
  id: string,
  patch: Partial<Pick<AgentDetail, "name" | "description" | "persona">> & {
    config?: AgentConfig;
    memory?: string;
  }
): Promise<{ id: string }> {
  return request<{ id: string }>(`/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteAgent(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// —— 技能（增删 + 启用/关闭；共享技能只能开/关，不能删）——

/** 新增 agent 私有技能 */
export function createAgentSkill(
  id: string,
  body: { name: string; description?: string; content?: string }
): Promise<{ name: string }> {
  return request<{ name: string }>(`/agents/${encodeURIComponent(id)}/skills`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 启用 / 关闭某个技能 */
export function setAgentSkillEnabled(
  id: string,
  name: string,
  enabled: boolean
): Promise<{ name: string; enabled: boolean; disabledSkills: string[] }> {
  return request(`/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

/** 删除 agent 私有技能 */
export function deleteAgentSkill(id: string, name: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
}

/** 单个技能的详情（含 SKILL.md 正文） */
export interface AgentSkillDetail extends AgentSkill {
  content: string;
}

export function getAgentSkillContent(id: string, name: string): Promise<AgentSkillDetail> {
  return request<AgentSkillDetail>(
    `/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`
  );
}

/** 初始化：幂等创建 4 位个人助理（已存在的不覆盖） */
export function ensurePersonalAssistants(): Promise<{ created: string[]; skipped: string[] }> {
  return request<{ created: string[]; skipped: string[] }>("/agents/ensure-personal", {
    method: "POST",
  });
}

/** 从本机文件夹导入技能 */
export function importAgentSkill(
  id: string,
  body: { sourcePath: string; name?: string; target?: "agent" | "shared" }
): Promise<{ name: string }> {
  return request<{ name: string }>(`/agents/${encodeURIComponent(id)}/skills/import`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * 上传技能文件夹（multipart）。字段名用各文件的相对路径（`webkitRelativePath`），
 * 后端据此还原目录树；必须含 `SKILL.md`。
 */
export async function uploadAgentSkill(
  id: string,
  files: File[],
  options: { name?: string; target?: "agent" | "shared" } = {}
): Promise<{ name: string }> {
  const form = new FormData();
  for (const file of files) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    form.append(rel, file, file.name);
  }
  const params = new URLSearchParams();
  if (options.name) params.set("name", options.name);
  if (options.target) params.set("target", options.target);
  const res = await fetch(
    `${getBaseUrl()}/agents/${encodeURIComponent(id)}/skills/upload?${params.toString()}`,
    { method: "POST", body: form }
  );
  const body = (await res.json().catch(() => null)) as
    | { name?: string; message?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  return { name: body?.name ?? "" };
}

/* ---------------------------------------------------------------- 记忆 */

export function getAgentMemory(id: string): Promise<string> {
  return request<unknown>(`/agents/${encodeURIComponent(id)}/memory`).then(
    normalizeTextResult
  );
}

export function putAgentMemory(id: string, content: string): Promise<unknown> {
  return request(`/agents/${encodeURIComponent(id)}/memory`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

/**
 * 分层记忆的**扁平**清单（任务 11.18）：`{ entries: [{ rel, type, size? }] }`。
 * 原样返回 `unknown`，由 `@/app/utils/memoryTree` 归一化成条目与树（容错缺 `type` 等情况）。
 * 后端未就绪时 404，调用方据此展示可读错误态（核心记忆仍可用旧端点读写）。
 */
export function getAgentMemoryTree(id: string): Promise<unknown> {
  return request<unknown>(`/agents/${encodeURIComponent(id)}/memory/tree`);
}

/** 读取某个记忆文件（`rel` 为记忆根下的相对路径，如 `/memory/2026-10-01.md`）。 */
export function getAgentMemoryFile(
  id: string,
  rel: string
): Promise<{ rel: string; content: string }> {
  return request<unknown>(
    `/agents/${encodeURIComponent(id)}/memory/file?rel=${encodeURIComponent(rel)}`
  ).then((raw) => {
    const record = asRecord(raw);
    return { rel: asString(record.rel) ?? rel, content: normalizeTextResult(raw) };
  });
}

export function getProjectMemory(workspace: string): Promise<string> {
  return request<unknown>(
    `/memory/project?path=${encodeURIComponent(workspace)}`
  ).then(normalizeTextResult);
}

export function putProjectMemory(
  workspace: string,
  content: string
): Promise<unknown> {
  return request(`/memory/project?path=${encodeURIComponent(workspace)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

/* ---------------------------------------------------------------- 绑定 */

export function getBinding(workspace: string): Promise<WorkspaceBindingRecord> {
  return request<unknown>(
    `/workspace/binding?path=${encodeURIComponent(workspace)}`
  ).then(normalizeBinding);
}

export function putBinding(
  workspace: string,
  agentId: string,
  mode: SwitchMode
): Promise<{ agentId: string }> {
  return request<{ agentId: string }>("/workspace/binding", {
    method: "PUT",
    body: JSON.stringify({ path: workspace, agentId, mode }),
  });
}