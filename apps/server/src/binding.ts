/**
 * 工作区 ↔ agent 绑定。
 *
 * ## 模型（2026-10-01 从 1:1 放宽成 N:1，对齐 QwenPaw）
 *
 * 一个工作区可以挂**多个** agent，其中一个是**当前激活**的（聊天面用的那个）。
 * 对应 QwenPaw 的 PawApp.agents（`AgentProfileRef { id, workspace_dir, enabled }`）+ 一个选中项。
 *
 * 绑定记录写在 `<工作区>/.open-assistant/project.json`（version 2）。
 * 绑定随工作区目录走（复制目录 = 复制绑定，无需重新配置）。
 *
 * ## 两条不变式
 *
 * 1. **默认 agent 永远是成员且永远启用** —— 它保证任何工作区都至少有一个能用的 agent，
 *    所以它不能被停用 / 移除（对齐 QwenPaw 里 `default` 不渲染开关按钮）。
 * 2. **停用或移除当前激活的 agent 时，激活位自动回落到默认 agent**（不留下悬空的激活位）。
 *
 * ## 归属
 *
 * - `enabled` 是**这个工作区对这个 agent** 的态度（同一个 agent 可以在 A 工作区启用、在 B 工作区停用）；
 * - `pinned` 是 **agent 自己的**全局偏好，所以它在 `agents/<id>/config.json` 里，不在这儿。
 *
 * ## 换绑（显式且可追溯）
 *
 * - 记录 `lastAgentSwitch`（此前激活的是谁、何时、为什么、用的哪种历史处置）；
 * - `mode: "keep"`（默认）：保留原有会话，并把它们标注为「创建时属于前一个 agent」；
 * - `mode: "archive"`：把原有会话整体转入 `<工作区>/.open-assistant/archive/<old-agent>/`（仍可查看）。
 *
 * ## 运行身份以激活位为准
 *
 * 客户端 run 里传的 `configurable.agent_id` 一律不采信；运行期身份只能来自这里的激活位
 * （见 workspace-middleware.ts）。激活位是权限边界：它决定用谁的工具白名单。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AgentError } from "./agents/errors.js";
import {
  agentExists,
  ensureAgent,
  isValidAgentId,
  listAgents,
  readAgent,
  type AgentStartupStatus,
} from "./agents/registry.js";
import { DEFAULT_AGENT_ID, DEFAULT_AGENT_NAME } from "./agents/root.js";
import { readJsonOrNull, statOrNull, writeJsonAtomic } from "./agents/json-file.js";
import {
  ensureAppDataDir,
  resolveWorkspaceDir,
  workspaceAppDataDir,
  workspaceSessionIndexPath,
} from "./workspace.js";

/** 绑定记录文件名（放在工作区的应用数据子目录里） */
export const PROJECT_FILE = "project.json";

/** 会话归属标注文件名（tasks 2 上线前的过渡载体） */
export const SESSION_OWNERS_FILE = "sessions-agents.json";

/** 归档区目录名 */
export const ARCHIVE_DIR = "archive";

export type SwitchMode = "keep" | "archive";

export interface AgentSwitchRecord {
  from: string;
  at: string;
  reason: string;
  mode: SwitchMode;
}

/** 工作区里挂着的某个 agent（QwenPaw: AgentProfileRef） */
export interface WorkspaceAgentRef {
  agentId: string;
  /** 是否在**这个工作区**里启用 */
  enabled: boolean;
  addedAt: string;
}

export interface WorkspaceBinding {
  version: 2;
  /** 这个工作区挂着的全部 agent（含停用的） */
  agents: WorkspaceAgentRef[];
  /** 聊天面当前用的那个；必须是 `agents` 里的一员且 enabled */
  activeAgentId: string;
  createdAt: string;
  lastAgentSwitch?: AgentSwitchRecord;
}

/** `<工作区>/.open-assistant/project.json` 的绝对路径 */
export function workspaceProjectPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), PROJECT_FILE);
}

function normalizeBinding(raw: unknown): WorkspaceBinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const createdAt =
    typeof obj["createdAt"] === "string" && obj["createdAt"].length > 0
      ? obj["createdAt"]
      : new Date().toISOString();

  let last: AgentSwitchRecord | undefined;
  const rawLast = obj["lastAgentSwitch"];
  if (typeof rawLast === "object" && rawLast !== null && !Array.isArray(rawLast)) {
    const rec = rawLast as Record<string, unknown>;
    if (typeof rec["from"] === "string" && rec["from"].length > 0) {
      last = {
        from: rec["from"],
        at: typeof rec["at"] === "string" ? rec["at"] : new Date().toISOString(),
        reason: typeof rec["reason"] === "string" ? rec["reason"] : "user",
        mode: rec["mode"] === "archive" ? "archive" : "keep",
      };
    }
  }

  const readRefs = (value: unknown): WorkspaceAgentRef[] => {
    if (!Array.isArray(value)) return [];
    const refs: WorkspaceAgentRef[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const agentId = rec["agentId"];
      if (typeof agentId !== "string" || agentId.trim().length === 0) continue;
      const id = agentId.trim();
      if (refs.some((r) => r.agentId === id)) continue; // 去重
      refs.push({
        agentId: id,
        enabled: rec["enabled"] !== false,
        addedAt: typeof rec["addedAt"] === "string" ? rec["addedAt"] : createdAt,
      });
    }
    return refs;
  };

  let agents = readRefs(obj["agents"]);
  // v1 兼容：老记录只有单个 agentId
  if (agents.length === 0) {
    const legacy = obj["agentId"];
    if (typeof legacy !== "string" || legacy.trim().length === 0) return null;
    agents = [{ agentId: legacy.trim(), enabled: true, addedAt: createdAt }];
  }

  // 不变式 1：默认 agent 必须是成员且启用
  const def = agents.find((r) => r.agentId === DEFAULT_AGENT_ID);
  if (def) def.enabled = true;
  else agents.unshift({ agentId: DEFAULT_AGENT_ID, enabled: true, addedAt: createdAt });

  // 不变式 2：激活位必须有效（存在且启用），否则回落默认 agent
  const rawActive = obj["activeAgentId"] ?? obj["agentId"];
  let activeAgentId =
    typeof rawActive === "string" && rawActive.trim().length > 0 ? rawActive.trim() : "";
  const activeRef = agents.find((r) => r.agentId === activeAgentId);
  if (!activeRef || !activeRef.enabled) activeAgentId = DEFAULT_AGENT_ID;

  const binding: WorkspaceBinding = { version: 2, agents, activeAgentId, createdAt };
  if (last) binding.lastAgentSwitch = last;
  return binding;
}

/**
 * 读取工作区绑定；文件不存在 → null（调用方按「未绑定」处理）。
 * 文件存在但结构非法 → 抛错（不静默当未绑定，否则会掩盖损坏的绑定记录）。
 *
 * v1（单 agent）记录会被就地读成 v2 形状，下次写入时落盘成 v2。
 */
export async function readBinding(workspaceDir: string): Promise<WorkspaceBinding | null> {
  const file = workspaceProjectPath(workspaceDir);
  const raw = await readJsonOrNull(file, (err) => {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `工作区绑定记录损坏：${err.message}`,
      400,
      PROJECT_FILE,
    );
  });
  if (raw === null) return null;
  const binding = normalizeBinding(raw);
  if (!binding) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `工作区绑定记录缺少 agent 信息：${file}`,
      400,
      PROJECT_FILE,
    );
  }
  return binding;
}

// —— 会话归属标注（过渡载体，tasks 2 后由 sqlite 承接）——

interface SessionOwners {
  version: 1;
  updatedAt: string;
  owners: Record<string, string>;
}

function ownersPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), SESSION_OWNERS_FILE);
}

async function readOwners(workspaceDir: string): Promise<SessionOwners> {
  const raw = (await readJsonOrNull(ownersPath(workspaceDir), () => {
    throw new AgentError("AGENT_INVALID_CONFIG", "会话归属标注文件损坏", 400, SESSION_OWNERS_FILE);
  })) as SessionOwners | null;
  if (!raw || typeof raw.owners !== "object" || raw.owners === null) {
    return { version: 1, updatedAt: new Date().toISOString(), owners: {} };
  }
  return { version: 1, updatedAt: raw.updatedAt ?? new Date().toISOString(), owners: raw.owners };
}

/** 把某条会话标注为「由 agentId 创建」（幂等，不覆盖已有标注） */
export async function stampSessionOwner(
  workspaceDir: string,
  threadId: string,
  agentId: string,
): Promise<void> {
  if (!threadId || !agentId) return;
  const data = await readOwners(workspaceDir);
  if (data.owners[threadId]) return;
  data.owners[threadId] = agentId;
  data.updatedAt = new Date().toISOString();
  await ensureAppDataDir(workspaceDir);
  await writeJsonAtomic(ownersPath(workspaceDir), data);
}

/** 读取会话归属标注（测试 / 前端标注用） */
export async function readSessionOwners(workspaceDir: string): Promise<Record<string, string>> {
  return (await readOwners(workspaceDir)).owners;
}

/** 把当前工作区会话索引里的所有会话标注为属于某 agent（换绑 keep 模式用） */
async function annotateExistingSessions(workspaceDir: string, agentId: string): Promise<string[]> {
  const indexPath = workspaceSessionIndexPath(workspaceDir);
  const raw = (await readJsonOrNull(indexPath, () => null)) as { sessions?: unknown } | null;
  const ids: string[] = [];
  if (raw && Array.isArray(raw.sessions)) {
    for (const entry of raw.sessions) {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  if (ids.length === 0) return ids;
  const data = await readOwners(workspaceDir);
  for (const id of ids) {
    if (!data.owners[id]) data.owners[id] = agentId;
  }
  data.updatedAt = new Date().toISOString();
  await ensureAppDataDir(workspaceDir);
  await writeJsonAtomic(ownersPath(workspaceDir), data);
  return ids;
}

/**
 * 归档换绑（mode=archive）：把工作区会话索引整体搬进
 * `<工作区>/.open-assistant/archive/<old-agent>/`，并留下一份清单。
 * 归档后工作区会话列表清空；归档区里的内容仍在（可查看，不删除）。
 */
async function archiveSessions(workspaceDir: string, agentId: string): Promise<string[]> {
  const indexPath = workspaceSessionIndexPath(workspaceDir);
  const raw = (await readJsonOrNull(indexPath, () => null)) as { sessions?: unknown } | null;
  const ids: string[] = [];
  if (raw && Array.isArray(raw.sessions)) {
    for (const entry of raw.sessions) {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  if (ids.length === 0) return ids;

  const archiveDir = path.join(workspaceAppDataDir(workspaceDir), ARCHIVE_DIR, agentId);
  await fs.mkdir(archiveDir, { recursive: true });
  const indexPathStat = await statOrNull(indexPath);
  if (indexPathStat) {
    await fs.rename(indexPath, path.join(archiveDir, "sessions.json"));
    await writeJsonAtomic(indexPath, { version: 1, updatedAt: new Date().toISOString(), sessions: [] });
  }
  const owners = await readOwners(workspaceDir);
  await writeJsonAtomic(path.join(archiveDir, "manifest.json"), {
    version: 1,
    agentId,
    archivedAt: new Date().toISOString(),
    sessionCount: ids.length,
    threadIds: ids,
    owners: Object.fromEntries(ids.map((id) => [id, owners.owners[id] ?? agentId])),
  });
  return ids;
}

export interface WriteBindingOptions {
  mode?: SwitchMode;
  reason?: string;
  displayName?: string;
}

export interface WriteBindingResult {
  binding: WorkspaceBinding;
  /** 本次是否发生了「激活位」变更（切到了别的 agent） */
  switched: boolean;
  /** keep 模式下被保留并标注的会话标识 */
  keptSessions?: string[];
  /** archive 模式下被归档的会话标识 */
  archivedSessions?: string[];
}

/** 把 agent 加进成员表（幂等）；返回是否真的新加了 */
function ensureRef(binding: WorkspaceBinding, agentId: string, enabled = true): boolean {
  if (binding.agents.some((r) => r.agentId === agentId)) return false;
  binding.agents.push({ agentId, enabled, addedAt: new Date().toISOString() });
  return true;
}

/** 停用某个成员；停用当前激活的 → 激活位回落默认 agent（不变式 2） */
function disableRef(binding: WorkspaceBinding, ref: WorkspaceAgentRef): void {
  if (ref.agentId === DEFAULT_AGENT_ID) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `默认 agent（${DEFAULT_AGENT_ID}）不能停用：它保证工作区始终有一个可用的助手`,
      400,
      "agentId",
    );
  }
  ref.enabled = false;
  if (binding.activeAgentId === ref.agentId) binding.activeAgentId = DEFAULT_AGENT_ID;
}

function assertAgentId(agentId: string): void {
  if (!isValidAgentId(agentId)) {
    throw new AgentError("AGENT_INVALID_ID", `agent 标识非法：${String(agentId)}`, 400, "agentId");
  }
}

async function assertAgentExists(agentId: string): Promise<void> {
  assertAgentId(agentId);
  if (!(await agentExists(agentId))) {
    throw new AgentError("AGENT_NOT_FOUND", `找不到 agent 定义 ${agentId}`, 404, "agentId");
  }
}

async function loadOrInit(workspaceDir: string): Promise<WorkspaceBinding> {
  const existing = await readBinding(workspaceDir);
  if (existing) return existing;
  const now = new Date().toISOString();
  return {
    version: 2,
    agents: [{ agentId: DEFAULT_AGENT_ID, enabled: true, addedAt: now }],
    activeAgentId: DEFAULT_AGENT_ID,
    createdAt: now,
  };
}

async function save(workspaceDir: string, binding: WorkspaceBinding): Promise<WorkspaceBinding> {
  await ensureAppDataDir(workspaceDir);
  await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
  return binding;
}

/**
 * 写入 / 更新工作区绑定：**把该 agent 设为当前激活**（并确保它是成员）。
 * - 未绑定 → 新建（成员表 = 默认 agent + 这个 agent）；
 * - 已激活同一个 agent → 幂等；
 * - 激活的是另一个 agent → 记 lastAgentSwitch + 按 mode 处置历史会话。
 */
export async function writeBinding(
  workspacePath: string,
  agentId: string,
  options: WriteBindingOptions = {},
): Promise<WriteBindingResult> {
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (id.length === 0) {
    throw new AgentError("AGENT_INVALID_ID", "缺少 agentId（绑定时必须指定一个 agent）", 400, "agentId");
  }
  // 绑定的 agent 必须存在，否则拒绝（对齐「绑定的 agent 不存在时阻止对话」的前置校验）
  if (!(await agentExists(id))) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `无法绑定：找不到 agent 定义 ${id}（agents 根下没有这个目录）`,
      404,
      "agentId",
    );
  }

  const mode: SwitchMode = options.mode === "archive" ? "archive" : "keep";
  const existing = await readBinding(workspaceDir);
  const now = new Date().toISOString();

  if (!existing) {
    const binding: WorkspaceBinding = {
      version: 2,
      agents: [
        { agentId: DEFAULT_AGENT_ID, enabled: true, addedAt: now },
        ...(id === DEFAULT_AGENT_ID ? [] : [{ agentId: id, enabled: true, addedAt: now }]),
      ],
      activeAgentId: id,
      createdAt: now,
    };
    await ensureAppDataDir(workspaceDir);
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
    return { binding, switched: false };
  }

  const next: WorkspaceBinding = {
    version: 2,
    agents: existing.agents.map((r) => ({ ...r })),
    activeAgentId: existing.activeAgentId,
    createdAt: existing.createdAt,
    ...(existing.lastAgentSwitch ? { lastAgentSwitch: existing.lastAgentSwitch } : {}),
  };
  ensureRef(next, id);
  // 重新激活一个被停用的 agent → 顺带启用它（否则激活位会立刻被判为无效）
  const ref = next.agents.find((r) => r.agentId === id)!;
  ref.enabled = true;

  if (existing.activeAgentId === id) {
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), next);
    return { binding: next, switched: false };
  }

  const from = existing.activeAgentId;
  let result: WriteBindingResult;
  if (mode === "archive") {
    const archived = await archiveSessions(workspaceDir, from);
    result = { binding: next, switched: true, archivedSessions: archived };
  } else {
    const kept = await annotateExistingSessions(workspaceDir, from);
    result = { binding: next, switched: true, keptSessions: kept };
  }
  result.binding.activeAgentId = id;
  result.binding.lastAgentSwitch = { from, at: now, reason: options.reason ?? "user", mode };
  await writeJsonAtomic(workspaceProjectPath(workspaceDir), result.binding);
  return result;
}

// —— 小步操作（选择器用：加成员 / 启用停用 / 切激活 / 移除）——

/** 把一个 agent 加进工作区（幂等）；`makeActive` 时同时切过去 */
export async function addWorkspaceAgent(
  workspacePath: string,
  agentId: string,
  opts: { enabled?: boolean; makeActive?: boolean } = {},
): Promise<WorkspaceBinding> {
  await assertAgentExists(agentId);
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await loadOrInit(workspaceDir);
  const fresh = ensureRef(binding, agentId, opts.enabled !== false);
  if (!fresh && opts.enabled !== undefined) {
    const ref = binding.agents.find((r) => r.agentId === agentId)!;
    if (opts.enabled === false) disableRef(binding, ref);
    else ref.enabled = true;
  }
  if (opts.makeActive) binding.activeAgentId = agentId;
  return save(workspaceDir, binding);
}

export async function setWorkspaceAgentEnabled(
  workspacePath: string,
  agentId: string,
  enabled: boolean,
): Promise<WorkspaceBinding> {
  assertAgentId(agentId);
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await loadOrInit(workspaceDir);
  const ref = binding.agents.find((r) => r.agentId === agentId);
  if (!ref) {
    if (!enabled) {
      // 停用一个本来就不在的成员 = 什么都不用做
      return save(workspaceDir, binding);
    }
    await assertAgentExists(agentId);
    ensureRef(binding, agentId, true);
    return save(workspaceDir, binding);
  }
  if (enabled) ref.enabled = true;
  else disableRef(binding, ref);
  return save(workspaceDir, binding);
}

/** 切换当前激活的 agent；必须是「已启用」的成员 */
export async function setActiveAgent(
  workspacePath: string,
  agentId: string,
): Promise<WorkspaceBinding> {
  assertAgentId(agentId);
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await loadOrInit(workspaceDir);
  const ref = binding.agents.find((r) => r.agentId === agentId);
  if (!ref) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `这个工作区里没有 ${agentId}：先把它加进来再切`,
      404,
      "agentId",
    );
  }
  if (!ref.enabled) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `${agentId} 在这个工作区里是停用状态，不能切过去（先启用它）`,
      400,
      "agentId",
    );
  }
  binding.activeAgentId = agentId;
  return save(workspaceDir, binding);
}

/** 从工作区移除一个成员；移除当前激活的 → 激活位回落默认 agent */
export async function removeWorkspaceAgent(
  workspacePath: string,
  agentId: string,
): Promise<WorkspaceBinding> {
  assertAgentId(agentId);
  if (agentId === DEFAULT_AGENT_ID) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `默认 agent（${DEFAULT_AGENT_ID}）不能从工作区移除`,
      400,
      "agentId",
    );
  }
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await loadOrInit(workspaceDir);
  binding.agents = binding.agents.filter((r) => r.agentId !== agentId);
  if (binding.activeAgentId === agentId) binding.activeAgentId = DEFAULT_AGENT_ID;
  return save(workspaceDir, binding);
}

/** 选择器用的条目 */
export interface WorkspaceAgentEntry {
  id: string;
  name: string;
  description?: string;
  /** 在这个工作区里启用了吗 */
  enabled: boolean;
  /** 是当前激活的那个吗 */
  active: boolean;
  // —— 以下来自 agent 自己的定义（全局）——
  pinned: boolean;
  availableInChat: boolean;
  startupStatus: AgentStartupStatus;
  valid: boolean;
  issues?: string[];
}

export interface WorkspaceAgentsView {
  workspace: string;
  activeAgentId: string;
  /** 这个工作区挂着的（含停用的） */
  members: WorkspaceAgentEntry[];
  /** 没挂上但可以加的 */
  candidates: WorkspaceAgentEntry[];
}

/** 汇总选择器需要的一切：工作区成员 + 候选，字段直接来自 agent 定义 */
export async function readWorkspaceAgentsView(
  workspacePath: string,
): Promise<WorkspaceAgentsView> {
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await readBinding(workspaceDir);
  const { agents } = await listAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));

  const toEntry = (id: string, enabled: boolean, active: boolean): WorkspaceAgentEntry => {
    const summary = byId.get(id);
    if (!summary) {
      // 定义已被删除，但工作区成员表里还留着 → 如实标成不可用，而不是假装它没问题
      return {
        id,
        name: id,
        enabled,
        active,
        pinned: false,
        availableInChat: false,
        startupStatus: "failed",
        valid: false,
        issues: ["agent 定义不存在（可能已被删除）"],
      };
    }
    const entry: WorkspaceAgentEntry = {
      id: summary.id,
      name: summary.name,
      enabled,
      active,
      pinned: summary.pinned,
      availableInChat: summary.availableInChat,
      startupStatus: summary.valid ? "running" : "failed",
      valid: summary.valid,
    };
    if (summary.description !== undefined) entry.description = summary.description;
    if (summary.issues !== undefined) entry.issues = summary.issues;
    return entry;
  };

  const activeAgentId = binding?.activeAgentId ?? DEFAULT_AGENT_ID;
  const members = (binding?.agents ?? []).map((r) =>
    toEntry(r.agentId, r.enabled, r.agentId === activeAgentId),
  );
  const memberIds = new Set(members.map((m) => m.id));
  const candidates = agents
    .filter((a) => !memberIds.has(a.id))
    .map((a) => toEntry(a.id, false, false));

  return { workspace: workspaceDir, activeAgentId, members, candidates };
}

/**
 * 幂等确保工作区绑定到某 agent（默认 agent）。脚本 / 迁移用：
 * agent 定义不存在则按默认骨架创建，工作区未绑或激活的不是目标 agent 则写入绑定。
 */
export async function ensureWorkspaceBinding(
  workspacePath: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<WorkspaceBinding> {
  await ensureAgent(agentId, agentId === DEFAULT_AGENT_ID ? DEFAULT_AGENT_NAME : undefined);
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const existing = await readBinding(workspaceDir);
  if (existing?.activeAgentId === agentId) return existing;
  const { binding } = await writeBinding(workspacePath, agentId, { reason: "ensure" });
  return binding;
}

/** 供 HTTP `GET /workspace/binding` 使用的只读视图（含 agent 显示名） */
export interface BindingView {
  agentId: string | null;
  agentName?: string;
  boundAt?: string;
  lastSwitch?: AgentSwitchRecord;
}

export async function readBindingView(workspacePath: string): Promise<BindingView> {
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await readBinding(workspaceDir);
  if (!binding) return { agentId: null };
  const view: BindingView = { agentId: binding.activeAgentId, boundAt: binding.createdAt };
  if (binding.lastAgentSwitch) view.lastSwitch = binding.lastAgentSwitch;
  try {
    const def = await readAgent(binding.activeAgentId);
    view.agentName = def.name;
  } catch {
    view.agentName = binding.activeAgentId; // 定义缺失时至少回显标识，便于前端提示
  }
  return view;
}