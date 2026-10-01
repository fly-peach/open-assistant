/**
 * 子智能体团队（`team/<子 agent 名>/SPEC.md`）的 HTTP 客户端。
 *
 * 对齐 specs/subagent-team「团队的可见与可编辑」与 design D4（只编辑 description / tools / model）：
 * - `GET    /agents/{id}/team`          → `{ agentId, dir, teamDir, exists, toolCatalog, members }`
 * - `PUT    /agents/{id}/team/{name}`   → `{ name, member }`（局部更新）
 * - `POST   /agents/{id}/team`          → `{ name }`（建目录 + 写 SPEC.md 骨架）
 *
 * 两个必须记住的语义（团队页全部交互都建立在它们上面）：
 *
 * 1. **字段缺席 = 不改；显式 `null` = 删除该 frontmatter 键**。
 *    所以「工具白名单留空」要传 `tools: null`（回到继承主 agent），
 *    而不是 `tools: []`（那是「一个工具都不给」，语义完全不同）。
 * 2. **列表里 `valid:false` 的成员照样列出来**（`issues` 说明原因），
 *    与 `GET /agents` 的「标注非法而不是整体失败」一致。
 *
 * 后端未就绪时这些端点会 404 / 网络失败，统一抛 `WorkspaceApiError`，
 * 页面据此展示可读错误态（而不是静默给空列表）。
 */
import { request } from "@/lib/workspaceApi";

/** 一条「这个声明哪里不合法」的可读原因（对齐后端 `collectIssues` 的逐项标注）。 */
export interface SubAgentIssue {
  code: string;
  /** 可读中文原因（由后端给出，前端原样渲染）。 */
  message: string;
}

/** 子 agent 的模型声明（缺省 = 不写这个键 → 沿用主 agent 的解析链）。 */
export interface SubAgentModel {
  id: string;
  providerId?: string;
}

/** 运行模式：只接受这两个值（`handoff` 之类的幽灵值会被后端拒绝）。 */
export type SubAgentMode = "isolated" | "fork";

export interface SubAgentMember {
  /** 目录名，也是该子 agent 的标识。 */
  name: string;
  dir: string;
  specPath: string;
  valid: boolean;
  issues: SubAgentIssue[];
  /** 路由描述：主 agent 依据它决定是否把任务派给这个子 agent。 */
  description: string;
  /** `null` = 未声明（继承主 agent 已开启的工具组）；`[]` = 显式「一个都不给」。 */
  tools: string[] | null;
  /** `null` = 未声明（沿用主 agent 的模型解析链）。 */
  model: SubAgentModel | null;
  /** `null` = 未声明（子 agent 默认不继承主 agent 的技能）。 */
  skills: string[] | null;
  mode: SubAgentMode;
  /** 正文，即该子 agent 的系统提示词。 */
  systemPrompt: string;
}

/**
 * 可选工具目录里的一组（由后端按主 agent 的 config.tools 现算）。
 * `enabled:false` 表示主 agent 关掉了这个工具组 —— 子 agent 勾了也拿不到
 * （specs/subagent-team「工具组开关对子 agent 生效」），界面必须显式说明。
 */
export interface ToolCatalogGroup {
  group: string;
  enabled: boolean;
  tools: string[];
}

export interface TeamView {
  agentId: string;
  /** 主 agent 目录（绝对路径）。 */
  dir: string;
  /** `team/` 目录（绝对路径）。 */
  teamDir: string;
  /** `team/` 是否存在。不存在时 `members` 为空且**不是错误**。 */
  exists: boolean;
  members: SubAgentMember[];
  toolCatalog: ToolCatalogGroup[];
}

/**
 * 局部更新载荷。
 * - `description` / `systemPrompt`：字符串，直接覆盖；
 * - `tools` / `model` / `skills`：`null` **删除**该 frontmatter 键（回到继承），
 *   数组 / 对象则写入；
 * - `mode`：`isolated` | `fork`。
 */
export interface SubAgentPatch {
  description?: string;
  tools?: string[] | null;
  model?: SubAgentModel | null;
  skills?: string[] | null;
  mode?: SubAgentMode;
  systemPrompt?: string;
}

/* ------------------------------------------------------------------ 归一化 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `null` 与「缺字段」要分清：这里只认显式的 `null` 与字符串数组。 */
function asNullableStringList(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeSubAgentModel(value: unknown): SubAgentModel | null {
  if (!value || typeof value !== "object") return null;
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) return null;
  const providerId = asString(record.providerId);
  return providerId ? { id, providerId } : { id };
}

export function normalizeSubAgentMember(raw: unknown): SubAgentMember | null {
  const record = asRecord(raw);
  const name = asString(record.name);
  if (!name) return null;
  return {
    name,
    dir: asString(record.dir) ?? "",
    specPath: asString(record.specPath) ?? "",
    // 后端没说非法就当合法（与 normalizeSummary 的 `valid !== false` 一致）。
    valid: record.valid !== false,
    issues: (Array.isArray(record.issues) ? record.issues : [])
      .map((item) => {
        const issue = asRecord(item);
        const message = asString(issue.message);
        if (!message) return null;
        return { code: asString(issue.code) ?? "UNKNOWN", message };
      })
      .filter((item): item is SubAgentIssue => item !== null),
    description: asString(record.description) ?? "",
    tools: asNullableStringList(record.tools),
    model: normalizeSubAgentModel(record.model),
    skills: asNullableStringList(record.skills),
    mode: record.mode === "fork" ? "fork" : "isolated",
    systemPrompt: asString(record.systemPrompt) ?? "",
  };
}

export function normalizeToolCatalog(raw: unknown): ToolCatalogGroup[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => {
      const record = asRecord(item);
      const group = asString(record.group);
      if (!group) return null;
      return {
        group,
        enabled: record.enabled === true,
        tools: (Array.isArray(record.tools) ? record.tools : []).filter(
          (name): name is string => typeof name === "string"
        ),
      };
    })
    .filter((item): item is ToolCatalogGroup => item !== null);
}

export function normalizeTeamView(agentId: string, raw: unknown): TeamView {
  const record = asRecord(raw);
  return {
    agentId: asString(record.agentId) ?? agentId,
    dir: asString(record.dir) ?? "",
    teamDir: asString(record.teamDir) ?? "",
    exists: record.exists === true,
    members: (Array.isArray(record.members) ? record.members : [])
      .map(normalizeSubAgentMember)
      .filter((item): item is SubAgentMember => item !== null),
    toolCatalog: normalizeToolCatalog(record.toolCatalog),
  };
}

/* ------------------------------------------------------------------ 端点 */

function teamPath(id: string): string {
  return `/agents/${encodeURIComponent(id)}/team`;
}

export function getTeam(id: string): Promise<TeamView> {
  return request<unknown>(teamPath(id)).then((raw) => normalizeTeamView(id, raw));
}

/**
 * 局部更新一个子 agent 的 `SPEC.md`（frontmatter ⊕ 正文一次写盘）。
 * 保存失败（如清空了 `description`）被后端拒绝时抛 `WorkspaceApiError`，
 * 调用方必须把 `message` 渲染出来（而不是只弹一个 toast）。
 */
export function updateSubAgent(
  id: string,
  name: string,
  patch: SubAgentPatch
): Promise<SubAgentMember | null> {
  return request<unknown>(`${teamPath(id)}/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  }).then((raw) => normalizeSubAgentMember(asRecord(raw).member));
}

/** 新建子 agent：建 `team/<name>/` 目录并写一份 `SPEC.md` 骨架。 */
export function createSubAgent(
  id: string,
  body: { name: string; description: string; systemPrompt?: string }
): Promise<{ name: string }> {
  return request<unknown>(teamPath(id), {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({ name: asString(asRecord(raw).name) ?? body.name }));
}
