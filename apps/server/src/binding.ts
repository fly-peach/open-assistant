/**
 * 工作区 ↔ agent 绑定（tasks 1.9–1.12，对齐 specs/agent-binding）。
 *
 * 一条规则：**一个工作区只绑一个 agent**，绑定记录写在 `<工作区>/.open-assistant/project.json`。
 * 绑定随工作区目录走（复制目录 = 复制绑定，无需重新配置）。
 *
 * ## 换绑（显式且可追溯）
 *
 * - 记录 `lastAgentSwitch`（此前绑的是谁、何时、为什么、用的哪种历史处置）；
 * - `mode: "keep"`（默认）：保留原有会话，并把它们标注为「创建时属于前一个 agent」；
 * - `mode: "archive"`：把原有会话整体转入 `<工作区>/.open-assistant/archive/<old-agent>/`（仍可查看）。
 *
 * ## 运行身份以绑定为准（tasks 1.12）
 *
 * 客户端 run 里传的 `configurable.agent_id` 一律不采信；运行期身份只能来自这里的绑定
 * （见 workspace-middleware.ts）。绑定是权限边界：它决定用谁的工具白名单。
 *
 * 说明：当前会话记录还是 `<工作区>/.open-assistant/sessions.json`（tasks 2 会换成 sqlite 三层表），
 * 所以「会话归属」在这里落成一份旁挂的 `.open-assistant/sessions-agents.json`，
 * 等 tasks 2 的 sqlite threads.agent_id 上线后可平滑替换。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AgentError } from "./agents/errors.js";
import { agentExists, ensureAgent, readAgent } from "./agents/registry.js";
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

export interface WorkspaceBinding {
  version: 1;
  agentId: string;
  displayName?: string;
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
  const agentId = obj["agentId"];
  if (typeof agentId !== "string" || agentId.trim().length === 0) return null;
  const createdAt =
    typeof obj["createdAt"] === "string" && obj["createdAt"].length > 0
      ? obj["createdAt"]
      : new Date().toISOString();
  const binding: WorkspaceBinding = { version: 1, agentId: agentId.trim(), createdAt };
  if (typeof obj["displayName"] === "string" && obj["displayName"].length > 0) {
    binding.displayName = obj["displayName"];
  }
  const last = obj["lastAgentSwitch"];
  if (typeof last === "object" && last !== null && !Array.isArray(last)) {
    const rec = last as Record<string, unknown>;
    if (typeof rec["from"] === "string" && rec["from"].length > 0) {
      const mode: SwitchMode = rec["mode"] === "archive" ? "archive" : "keep";
      binding.lastAgentSwitch = {
        from: rec["from"],
        at: typeof rec["at"] === "string" ? rec["at"] : new Date().toISOString(),
        reason: typeof rec["reason"] === "string" ? rec["reason"] : "user",
        mode,
      };
    }
  }
  return binding;
}

/**
 * 读取工作区绑定；文件不存在 → null（调用方按「未绑定」处理）。
 * 文件存在但结构非法 → 抛错（不静默当未绑定，否则会掩盖损坏的绑定记录）。
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
      `工作区绑定记录缺少 agentId：${file}`,
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
  /** 本次是否发生了换绑（从别的 agent 切过来） */
  switched: boolean;
  /** keep 模式下被保留并标注的会话标识 */
  keptSessions?: string[];
  /** archive 模式下被归档的会话标识 */
  archivedSessions?: string[];
}

/**
 * 写入 / 更新工作区绑定。
 * - 未绑定 → 新建绑定（createdAt = now）；
 * - 已绑定同一个 agent → 幂等更新（可改 displayName），不算换绑；
 * - 已绑定另一个 agent → 换绑：记录 lastAgentSwitch + 按 mode 处置历史。
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
    const binding: WorkspaceBinding = { version: 1, agentId: id, createdAt: now };
    if (options.displayName) binding.displayName = options.displayName;
    await ensureAppDataDir(workspaceDir);
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
    return { binding, switched: false };
  }

  if (existing.agentId === id) {
    const binding: WorkspaceBinding = { ...existing };
    if (options.displayName !== undefined) binding.displayName = options.displayName;
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
    return { binding, switched: false };
  }

  const from = existing.agentId;
  let result: WriteBindingResult;
  if (mode === "archive") {
    const archived = await archiveSessions(workspaceDir, from);
    result = {
      binding: {
        version: 1,
        agentId: id,
        createdAt: existing.createdAt,
        ...(existing.displayName ? { displayName: existing.displayName } : {}),
        lastAgentSwitch: { from, at: now, reason: options.reason ?? "user", mode },
      },
      switched: true,
      archivedSessions: archived,
    };
  } else {
    const kept = await annotateExistingSessions(workspaceDir, from);
    result = {
      binding: {
        version: 1,
        agentId: id,
        createdAt: existing.createdAt,
        ...(existing.displayName ? { displayName: existing.displayName } : {}),
        lastAgentSwitch: { from, at: now, reason: options.reason ?? "user", mode },
      },
      switched: true,
      keptSessions: kept,
    };
  }
  await writeJsonAtomic(workspaceProjectPath(workspaceDir), result.binding);
  return result;
}

/**
 * 幂等确保工作区绑定到某 agent（默认 agent）。脚本 / 迁移用：
 * agent 定义不存在则按默认骨架创建，工作区未绑或绑的不是目标 agent 则写入绑定。
 */
export async function ensureWorkspaceBinding(
  workspacePath: string,
  agentId: string = DEFAULT_AGENT_ID,
): Promise<WorkspaceBinding> {
  await ensureAgent(agentId, agentId === DEFAULT_AGENT_ID ? DEFAULT_AGENT_NAME : undefined);
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const existing = await readBinding(workspaceDir);
  if (existing?.agentId === agentId) return existing;
  const { binding } = await writeBinding(workspacePath, agentId, { reason: "ensure" });
  return binding;
}

/** 供 HTTP `GET /workspace/binding` 使用的只读视图（含 agent 显示名） */export interface BindingView {
  agentId: string | null;
  agentName?: string;
  displayName?: string;
  boundAt?: string;
  lastSwitch?: AgentSwitchRecord;
}

export async function readBindingView(workspacePath: string): Promise<BindingView> {
  const workspaceDir = await resolveWorkspaceDir(workspacePath);
  const binding = await readBinding(workspaceDir);
  if (!binding) return { agentId: null };
  const view: BindingView = { agentId: binding.agentId, boundAt: binding.createdAt };
  if (binding.displayName) view.displayName = binding.displayName;
  if (binding.lastAgentSwitch) view.lastSwitch = binding.lastAgentSwitch;
  try {
    const def = await readAgent(binding.agentId);
    view.agentName = def.name;
  } catch {
    view.agentName = binding.agentId; // 定义缺失时至少回显标识，便于前端提示
  }
  return view;
}
