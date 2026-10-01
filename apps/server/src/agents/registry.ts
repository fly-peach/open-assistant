/**
 * Agent 注册表（tasks 1.1–1.8，对齐 specs/agent-registry）。
 *
 * 一个 agent = `<agents 根>/<agent-id>/` 下的一个目录；目录名即标识。
 * 本模块负责：创建 / 列出 / 读取 / 更新 / 删除定义，以及**按 agent_id 解析并缓存运行实例**。
 *
 * ## 运行实例缓存（tasks 1.6，对齐「复用已解析的实例」/「定义变更后生效」）
 *
 * `resolveAgentRuntime(id)` 把「配置 + 人设 + 记忆 + 技能」解析成一个不可变快照并缓存。
 * 缓存键是 agent_id，附带一个 **fingerprint**（config.json / AGENTS.md / 分层记忆的 mtime+size）。
 * 每次解析都先算 fingerprint：
 * - 一致 → 直接复用缓存实例（不重复读盘、不重新构建）；
 * - 不一致（人设 / 配置 / 记忆被改）→ 失效重建，下一轮就用新定义。
 * 写路径（create/update/delete）也会主动失效，避免同一进程内读到旧值。
 *
 * 注意：本项目当前是「同一张图 + 按 agent_id 解析定义」的形态（design D3 / D10），
 * 因此「实例」= 该 agent 的运行时定义快照（人设 / 记忆 / 配置），由中间件在每轮注入。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AgentError } from "./errors.js";
import {
  AGENT_CONFIG_FILE,
  AGENT_CORE_MEMORY_FILE,
  AGENT_HEARTBEAT_FILE,
  AGENT_MEMORY_DIR,
  AGENT_DIGEST_DIR,
  AGENT_PERSONA_FILE,
  AGENT_SKILLS_DIR,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  SHARED_SKILLS_DIR,
  agentDirPath,
  ensureAgentsRoot,
  getAgentsRoot,
} from "./root.js";
import { readJsonOrNull, statOrNull, writeJsonAtomic } from "./json-file.js";
import {
  type AgentConfig,
  defaultAgentConfig,
  normalizeAgentConfig,
} from "./config.js";
import {
  ensureMemoryLayout,
  readCoreMemory,
  readMemoryForPrompt,
  writeCoreMemory,
} from "./memory.js";
import { type AgentSkillMeta, listAgentSkills } from "./skills.js";
import { DEFAULT_AGENT_PERSONA, readPersonaFile } from "../persona.js";
import { DEFAULT_AGENT_HEARTBEAT } from "./heartbeat-default.js";

// —— 标识校验（tasks 1.3）——

/**
 * 合法 agent 标识：非空、≤64 字符、无空白、无路径分隔符、无 `..`、不以 `.` 开头。
 * 目录名就是标识，所以这些字符会直接影响文件系统布局，必须在入口拒绝。
 */
export function isValidAgentId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 64) return false;
  if (id.trim() !== id) return false;
  if (/\s/.test(id)) return false;
  if (id === "." || id === "..") return false;
  if (id.startsWith(".")) return false;
  if (id.includes("..")) return false;
  if (id.includes("\0")) return false;
  if (/[/\\:*?"<>|]/.test(id)) return false;
  return true;
}

function assertValidAgentId(id: unknown): asserts id is string {
  if (!isValidAgentId(id)) {
    throw new AgentError(
      "AGENT_INVALID_ID",
      `非法 agent 标识 ${JSON.stringify(id)}：不能为空、不能含空白 / 路径分隔符 / ".." / 冒号等特殊字符，长度不超过 64`,
      400,
      "id",
    );
  }
}

// —— 读取定义 ——

/**
 * 列表项里的模型摘要（`config.json` 的 `model` 字段原样带出，只保留可展示的两个字段）。
 *
 * 为什么要在列表里带：不同 agent 可以各配各的模型（见 specs/agent-registry
 *「Agent 的配置项」），列表页要能一眼看出「这个 agent 到底用哪个模型」，
 * 而不是逐个点进去才知道。`null`（配置里没写）表示跟随全局默认。
 */
export interface AgentModelSummary {
  id: string;
  providerId?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  /** 配置里显式指定的模型；缺省（跟随全局默认）时该字段不出现 */
  model?: AgentModelSummary | null;
  valid: boolean;
  issues?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  config: AgentConfig;
  /** agent 目录里 AGENTS.md 的内容；缺失 → ""（运行期回退下一档） */
  persona: string;
  memory: string;
  skills: AgentSkillMeta[];
  dir: string;
}

/** 读取 agent 的配置（缺字段用默认；非法值抛 AGENT_INVALID_CONFIG） */
export async function readAgentConfig(agentId: string, dir: string): Promise<AgentConfig> {
  const configPath = path.join(dir, AGENT_CONFIG_FILE);
  const raw = await readJsonOrNull(configPath, (err) => {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `agent ${agentId} 的 ${AGENT_CONFIG_FILE} 无法解析：${err.message}`,
      400,
      AGENT_CONFIG_FILE,
    );
  });
  return normalizeAgentConfig(raw, `agent ${agentId}`, { id: agentId });
}

/** 列出某个 agent 目录的异常项（缺人设 / 缺配置 / 配置非法），供列表页标注 */
async function collectIssues(agentId: string, dir: string): Promise<string[]> {
  const issues: string[] = [];
  const persona = await readPersonaFile(dir, AGENT_PERSONA_FILE);
  if (!persona) issues.push(`缺少人设文件 ${AGENT_PERSONA_FILE}`);
  const configStat = await statOrNull(path.join(dir, AGENT_CONFIG_FILE));
  if (!configStat) {
    issues.push(`缺少配置文件 ${AGENT_CONFIG_FILE}`);
  } else {
    try {
      await readAgentConfig(agentId, dir);
    } catch (err) {
      issues.push((err as Error).message);
    }
  }
  return issues;
}

async function readDefinition(id: string, dir: string): Promise<AgentDefinition> {
  const config = await readAgentConfig(id, dir);
  const persona = (await readPersonaFile(dir, AGENT_PERSONA_FILE)) ?? "";
  // 注入上下文用的是**带上限的核心记忆**（task 11.3），不是全文
  const memory = (await readMemoryForPrompt(dir)).content;
  const skills = await listAgentSkills(dir);
  return {
    id,
    name: config.name,
    description: config.description,
    config,
    persona,
    memory,
    skills,
    dir,
  };
}

// —— 创建 ——

export interface CreateAgentInput {
  id: unknown;
  name?: string | undefined;
  description?: string | undefined;
}

/**
 * 创建 agent 目录骨架：AGENTS.md + config.json + 分层记忆（MEMORY.md / memory/ / digest/）+ skills/。
 * 标识非法 → 拒绝；同名已存在 → 409（不覆盖）。
 */
export async function createAgent(input: CreateAgentInput): Promise<string> {
  const id = typeof input.id === "string" ? input.id.trim() : input.id;
  assertValidAgentId(id);
  const root = await ensureAgentsRoot();
  const dir = path.join(root, id);
  const existing = await statOrNull(dir);
  if (existing) {
    throw new AgentError("AGENT_ALREADY_EXISTS", `agent 已存在：${id}`, 409, "id");
  }
  await fs.mkdir(path.join(dir, AGENT_SKILLS_DIR), { recursive: true });
  await fs.writeFile(path.join(dir, AGENT_PERSONA_FILE), DEFAULT_AGENT_PERSONA, "utf8");
  await fs.writeFile(path.join(dir, AGENT_HEARTBEAT_FILE), DEFAULT_AGENT_HEARTBEAT, "utf8");
  const config = defaultAgentConfig({ id, name: input.name, description: input.description });
  await writeJsonAtomic(path.join(dir, AGENT_CONFIG_FILE), config);
  await ensureMemoryLayout(dir);
  invalidateAgentRuntime(id);
  return id;
}

// —— 列出 ——

export interface AgentListResult {
  root: string;
  agents: AgentSummary[];
}

/** 列出根目录下的全部 agent（跳过共享技能池 `_shared`），并标注异常项而非整体失败 */
export async function listAgents(): Promise<AgentListResult> {
  const root = await ensureAgentsRoot();
  let entries = await fs.readdir(root, { withFileTypes: true });
  let dirs = entries.filter((e) => e.isDirectory() && e.name !== SHARED_SKILLS_DIR);
  if (dirs.length === 0) {
    // 首次使用：根目录是空的 → 播种默认 agent，保证用户一进来就有可用的助手定义
    await ensureDefaultAgent();
    entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory() && e.name !== SHARED_SKILLS_DIR);
  }

  const agents: AgentSummary[] = [];
  for (const entry of dirs) {
    const id = entry.name;
    const dir = path.join(root, id);
    if (!isValidAgentId(id)) {
      agents.push({ id, name: id, valid: false, issues: ["目录名不是合法的 agent 标识"] });
      continue;
    }
    const issues = await collectIssues(id, dir);
    let name = id;
    let description: string | undefined;
    // undefined = 配置读不出来（别把「读不到」说成「跟随全局默认」）
    let model: AgentModelSummary | null | undefined = undefined;
    try {
      const config = await readAgentConfig(id, dir);
      name = config.name;
      if (config.description.length > 0) description = config.description;
      model = config.model
        ? {
            id: config.model.id,
            ...(config.model.providerId ? { providerId: config.model.providerId } : {}),
          }
        : null;
    } catch {
      // 配置非法 → 用目录名兜底展示，异常已记在 issues 里
      model = undefined;
    }
    const summary: AgentSummary = { id, name, valid: issues.length === 0 };
    if (description !== undefined) summary.description = description;
    if (model !== undefined) summary.model = model;
    if (issues.length > 0) summary.issues = issues;
    agents.push(summary);
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  return { root, agents };
}

// —— 读取 / 更新 / 删除 ——

/** 读取单个 agent 定义；不存在 → 404 */
export async function readAgent(agentId: string): Promise<AgentDefinition> {
  assertValidAgentId(agentId);
  const dir = agentDirPath(agentId);
  const st = await statOrNull(dir);
  if (!st?.isDirectory()) {
    throw new AgentError("AGENT_NOT_FOUND", `找不到 agent 定义：${agentId}（目录 ${dir}）`, 404, "id");
  }
  return readDefinition(agentId, dir);
}

export interface UpdateAgentInput {
  name?: unknown;
  description?: unknown;
  config?: unknown;
  persona?: unknown;
  memory?: unknown;
}

/** 更新 agent 定义的部分字段（配置做浅合并后整体校验；人设 / 记忆整体覆盖） */
export async function updateAgent(agentId: string, patch: UpdateAgentInput): Promise<string> {
  assertValidAgentId(agentId);
  const dir = agentDirPath(agentId);
  const st = await statOrNull(dir);
  if (!st?.isDirectory()) {
    throw new AgentError("AGENT_NOT_FOUND", `找不到 agent 定义：${agentId}`, 404, "id");
  }

  const current = await readAgentConfig(agentId, dir);
  let nextRaw: Record<string, unknown> = { ...current, tools: { ...current.tools } };

  if (patch.config !== undefined) {
    if (typeof patch.config !== "object" || patch.config === null || Array.isArray(patch.config)) {
      throw new AgentError("AGENT_INVALID_CONFIG", "config 必须是一个 JSON 对象", 400, "config");
    }
    const incoming = patch.config as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...nextRaw, ...incoming };
    if (incoming["tools"] && typeof incoming["tools"] === "object" && !Array.isArray(incoming["tools"])) {
      merged["tools"] = { ...current.tools, ...(incoming["tools"] as Record<string, unknown>) };
    }
    if (
      incoming["model"] &&
      typeof incoming["model"] === "object" &&
      !Array.isArray(incoming["model"]) &&
      current.model
    ) {
      merged["model"] = { ...current.model, ...(incoming["model"] as Record<string, unknown>) };
    }
    nextRaw = merged;
  }

  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.trim().length === 0) {
      throw new AgentError("AGENT_INVALID_CONFIG", "name 必须是非空字符串", 400, "name");
    }
    nextRaw["name"] = patch.name.trim();
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") {
      throw new AgentError("AGENT_INVALID_CONFIG", "description 必须是字符串", 400, "description");
    }
    nextRaw["description"] = patch.description;
  }

  const config = normalizeAgentConfig(nextRaw, `agent ${agentId}`, { id: agentId });
  await writeJsonAtomic(path.join(dir, AGENT_CONFIG_FILE), config);

  if (patch.persona !== undefined) {
    if (typeof patch.persona !== "string") {
      throw new AgentError("AGENT_INVALID_CONFIG", "persona 必须是字符串", 400, "persona");
    }
    await fs.writeFile(path.join(dir, AGENT_PERSONA_FILE), patch.persona, "utf8");
  }
  if (patch.memory !== undefined) {
    if (typeof patch.memory !== "string") {
      throw new AgentError("AGENT_INVALID_CONFIG", "memory 必须是字符串", 400, "memory");
    }
    await writeCoreMemory(dir, patch.memory);
  }

  invalidateAgentRuntime(agentId);
  return agentId;
}

/** 删除 agent 定义（整目录删除） */
export async function deleteAgent(agentId: string): Promise<void> {
  assertValidAgentId(agentId);
  const dir = agentDirPath(agentId);
  const st = await statOrNull(dir);
  if (!st?.isDirectory()) {
    throw new AgentError("AGENT_NOT_FOUND", `找不到 agent 定义：${agentId}`, 404, "id");
  }
  await fs.rm(dir, { recursive: true, force: true });
  invalidateAgentRuntime(agentId);
}

/** agent 定义是否存在 */
export async function agentExists(agentId: string): Promise<boolean> {
  if (!isValidAgentId(agentId)) return false;
  const st = await statOrNull(agentDirPath(agentId));
  return st?.isDirectory() ?? false;
}

// —— 默认 agent 播种 ——

/** 所有 agent 标识（跳过共享技能池） */
export async function listAgentIds(): Promise<string[]> {
  const root = await ensureAgentsRoot();
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name !== SHARED_SKILLS_DIR)
    .map((e) => e.name)
    .sort();
}

/** 根目录为空时播种默认 agent（id xiaozhu / 显示名「小助」/ 内置默认人设） */
export async function ensureDefaultAgent(): Promise<string> {
  const ids = await listAgentIds();
  if (ids.length > 0) return DEFAULT_AGENT_ID;
  await createAgent({ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME });
  return DEFAULT_AGENT_ID;
}

/** 确保某个 agent 定义存在；不存在则按默认骨架创建（脚本 / 迁移用，幂等） */
export async function ensureAgent(
  id: string,
  name?: string,
): Promise<string> {
  if (await agentExists(id)) return id;
  return createAgent({ id, name: name ?? id });
}

// —— 运行实例解析与缓存（tasks 1.6）——

export interface AgentRuntime {
  id: string;
  dir: string;
  config: AgentConfig;
  /** agent 目录 AGENTS.md 的内容；null 表示缺失（运行期进入工作区 / 内置档） */
  persona: string | null;
  memory: string;
  skills: AgentSkillMeta[];
  fingerprint: string;
  builtAt: string;
}

const runtimeCache = new Map<string, AgentRuntime>();

/** fingerprint：配置 / 人设 / 记忆 的内容指纹（mtime + size），任一变化即失效 */
async function runtimeFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of [AGENT_CONFIG_FILE, AGENT_PERSONA_FILE, AGENT_CORE_MEMORY_FILE]) {
    const st = await statOrNull(path.join(dir, name));
    parts.push(st ? `${name}:${st.mtimeMs}:${st.size}` : `${name}:missing`);
  }
  // 分层记忆是目录：用目录 mtime 近似（新增/删除当日笔记会更新它）
  for (const name of [AGENT_MEMORY_DIR, AGENT_DIGEST_DIR]) {
    const st = await statOrNull(path.join(dir, name));
    parts.push(st ? `${name}:${st.mtimeMs}` : `${name}:missing`);
  }
  return parts.join("|");
}

/**
 * 按 agent_id 解析运行实例（配置 / 人设 / 记忆 / 技能），带缓存与失效重建。
 * agent 目录不存在 → AGENT_NOT_FOUND；配置非法 → AGENT_INVALID_CONFIG。
 */
export async function resolveAgentRuntime(agentId: string): Promise<AgentRuntime> {
  assertValidAgentId(agentId);
  const dir = agentDirPath(agentId);
  const st = await statOrNull(dir);
  if (!st?.isDirectory()) {
    throw new AgentError(
      "AGENT_NOT_FOUND",
      `工作区绑定的 agent 定义不存在：${agentId}（期望目录 ${dir}）。请检查绑定或重建该 agent。`,
      404,
      "agentId",
    );
  }
  const fingerprint = await runtimeFingerprint(dir);
  const cached = runtimeCache.get(agentId);
  if (cached && cached.fingerprint === fingerprint && cached.dir === dir) return cached;

  const config = await readAgentConfig(agentId, dir);
  const persona = await readPersonaFile(dir, AGENT_PERSONA_FILE);
  // 运行实例里带**核心记忆**（供注入）；细节走 memory_search / memory_read
  const memory = await readCoreMemory(dir);
  const skills = await listAgentSkills(dir);
  const runtime: AgentRuntime = {
    id: agentId,
    dir,
    config,
    persona,
    memory,
    skills,
    fingerprint,
    builtAt: new Date().toISOString(),
  };
  runtimeCache.set(agentId, runtime);
  return runtime;
}

/** 主动失效某个 agent 的运行实例缓存 */
export function invalidateAgentRuntime(agentId: string): void {
  runtimeCache.delete(agentId);
}

/** 清空全部运行实例缓存（测试用） */
export function clearAgentRuntimeCache(): void {
  runtimeCache.clear();
}

/** 当前缓存里的 agent 标识（测试断言「复用已解析的实例」用） */
export function cachedAgentIds(): string[] {
  return [...runtimeCache.keys()].sort();
}

/** 供 HTTP `GET /agents` 使用：根路径（只读） */
export function agentsRoot(): string {
  return getAgentsRoot();
}