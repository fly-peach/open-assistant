/**
 * 工作区 ↔ agent 绑定（**1:1**）。
 *
 * ## 模型（照 QwenPaw 的 `AgentProfileRef { id, workspace_dir, enabled, pinned }`）
 *
 * **一个工作区只由一位 agent 维护；一位 agent 也只维护一个工作区。**
 * 绑定记录写在 `<工作区>/.open-assistant/project.json`，绑定随工作区目录走
 * （复制目录 = 复制绑定，无需重新配置）。
 *
 * 那条「一个 agent 只维护一个目录」的另一半，由 agent 自己的
 * `config.json.workspaceDir` 承载并在写入时校验（见 agents/registry.ts 的
 * `setAgentWorkspaceDir` / `findAgentByWorkspaceDir`）—— 两份记录互为镜像，
 * 这里负责「目录 → agent」，那边负责「agent → 目录」。
 *
 * ## 换绑（显式且可追溯）
 *
 * - 记录 `lastAgentSwitch`（此前绑的是谁、何时、为什么、用的哪种历史处置）；
 * - `mode: "keep"`（默认）：保留原有会话，并把它们标注为「创建时属于前一个 agent」；
 * - `mode: "archive"`：把原有会话整体转入 `<工作区>/.open-assistant/archive/<old-agent>/`（仍可查看）。
 *
 * ## 运行身份以绑定为准
 *
 * 客户端 run 里传的 `configurable.agent_id` 一律不采信；运行期身份只能来自这里的绑定
 * （见 workspace-middleware.ts）。绑定是权限边界：它决定用谁的工具白名单。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AgentError } from "./agents/errors.js";
import { agentExists, ensureAgent, readAgent } from "./agents/registry.js";
import { DEFAULT_AGENT_ID, DEFAULT_AGENT_NAME } from "./agents/root.js";
import {
  claimWorkspaceDir,
  releaseWorkspaceDir,
} from "./agents/registry.js";
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
  version: 2;
  /** 维护这个工作区的那位 agent（有且仅有一位） */
  agentId: string;
  createdAt: string;
  lastAgentSwitch?: AgentSwitchRecord;
}

/** `<工作区>/.open-assistant/project.json` 的绝对路径 */
export function workspaceProjectPath(workspaceDir: string): string {
  return path.join(workspaceAppDataDir(workspaceDir), PROJECT_FILE);
}

/**
 * 归一化绑定记录，容忍三种历史写法（都是「目录 → agent」的同一个事实）：
 * - `{ agentId }`            —— 一直以来的 1:1 写法
 * - `{ activeAgentId }`      —— 2026-10-01 那次 N:1 试验的错误写法，取它的激活位
 * - `{ agents: [...], activeAgentId }` —— 同上，激活位缺失时取第一个
 */
function normalizeBinding(raw: unknown): WorkspaceBinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const createdAt =
    typeof obj["createdAt"] === "string" && obj["createdAt"].length > 0
      ? obj["createdAt"]
      : new Date().toISOString();

  const asId = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  let agentId = asId(obj["agentId"]) ?? asId(obj["activeAgentId"]);
  if (!agentId && Array.isArray(obj["agents"])) {
    const first = (obj["agents"] as unknown[]).find(
      (entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
    if (first) agentId = asId((first as Record<string, unknown>)["agentId"]);
  }
  if (!agentId) return null;

  const binding: WorkspaceBinding = { version: 2, agentId, createdAt };
  const rawLast = obj["lastAgentSwitch"];
  if (typeof rawLast === "object" && rawLast !== null && !Array.isArray(rawLast)) {
    const rec = rawLast as Record<string, unknown>;
    if (typeof rec["from"] === "string" && rec["from"].length > 0) {
      binding.lastAgentSwitch = {
        from: rec["from"],
        at: typeof rec["at"] === "string" ? rec["at"] : new Date().toISOString(),
        reason: typeof rec["reason"] === "string" ? rec["reason"] : "user",
        mode: rec["mode"] === "archive" ? "archive" : "keep",
      };
    }
  }
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
 * - 已绑定同一个 agent → 幂等，不算换绑；
 * - 已绑定另一个 agent → 换绑：记 lastAgentSwitch + 按 mode 处置历史会话。
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
    const binding: WorkspaceBinding = { version: 2, agentId: id, createdAt: now };
    await ensureAppDataDir(workspaceDir);
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
    await claimWorkspaceDir(id, workspaceDir);
    return { binding, switched: false };
  }

  if (existing.agentId === id) {
    // 幂等：同一个 agent 重复绑定不该记成一次「换绑」
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), existing);
    // 老数据可能只有绑定、没有镜像：顺手追平
    await claimWorkspaceDir(id, workspaceDir);
    return { binding: existing, switched: false };
  }

  // 换绑：1:1 下「把目录交给另一个 agent」= 前一位交出这个目录。
  // 前一位的 config.json.workspaceDir 也要跟着清掉，否则它还会声称在维护这个目录，
  // 下次别人想绑就会被「已由 X 维护」拦下（两份镜像记录必须同时更新）。
  const from = existing.agentId;
  // 1:1 的两份镜像记录必须同时更新：旧 agent 交出这个目录，新 agent 认领它。
  // 少了这一步，旧 agent 会一直声称在维护这个目录，下次别人想绑就被「已由 X 维护」拦下。
  await releaseWorkspaceDir(from, workspaceDir);
  if (mode === "archive") {
    const archived = await archiveSessions(workspaceDir, from);
    const binding: WorkspaceBinding = {
      version: 2,
      agentId: id,
      createdAt: existing.createdAt,
      lastAgentSwitch: { from, at: now, reason: options.reason ?? "user", mode },
    };
    await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
    await claimWorkspaceDir(id, workspaceDir);
    return { binding, switched: true, archivedSessions: archived };
  }
  const kept = await annotateExistingSessions(workspaceDir, from);
  const binding: WorkspaceBinding = {
    version: 2,
    agentId: id,
    createdAt: existing.createdAt,
    lastAgentSwitch: { from, at: now, reason: options.reason ?? "user", mode },
  };
  await writeJsonAtomic(workspaceProjectPath(workspaceDir), binding);
  await claimWorkspaceDir(id, workspaceDir);
  return { binding, switched: true, keptSessions: kept };
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
  const view: BindingView = { agentId: binding.agentId, boundAt: binding.createdAt };
  if (binding.lastAgentSwitch) view.lastSwitch = binding.lastAgentSwitch;
  try {
    const def = await readAgent(binding.agentId);
    view.agentName = def.name;
  } catch {
    view.agentName = binding.agentId; // 定义缺失时至少回显标识，便于前端提示
  }
  return view;
}