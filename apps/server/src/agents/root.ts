/**
 * agents 根目录解析（tasks 1.1）。
 *
 * 解析顺序：
 * 1. 环境变量 `AGENTS_ROOT`（可覆盖，非空时优先）
 * 2. 默认 `~/open-assistant-agents`（用户主目录下，跨项目共享）
 *
 * 目录布局（对齐 specs/agent-registry「Agent 定义的存放与结构」）：
 *   <agents 根>/<agent-id>/
 *     AGENTS.md    人设
 *     config.json  模型 / 工具白名单 / 审批级别 / 同侪开关 / 可联系名单
 *     memory.md    跨工作区共享的长期记忆
 *     skills/      技能目录（每个技能一个子目录，内含 SKILL.md）
 *     team/        子 agent 团队（每个子 agent 一个子目录，内含 SPEC.md）
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

/** 默认 agent 标识与显示名（本组已定默认，见任务说明） */
export const DEFAULT_AGENT_ID = "xiaozhu";
export const DEFAULT_AGENT_NAME = "小助";

/** 覆盖 agents 根的环境变量 */
export const AGENTS_ROOT_ENV = "AGENTS_ROOT";

/** agent 目录内的固定文件名 */
export const AGENT_PERSONA_FILE = "AGENTS.md";
export const AGENT_CONFIG_FILE = "config.json";
/** 核心长期记忆（design D12：分层记忆的第一层，每轮注入） */
export const AGENT_CORE_MEMORY_FILE = "MEMORY.md";
/** 日记忆目录（日记 + 按日的主题笔记） */
export const AGENT_MEMORY_DIR = "memory";
/** 消化产物目录 */
export const AGENT_DIGEST_DIR = "digest";
/** 外部导入子目录（位于日记忆目录下） */
export const AGENT_IMPORTS_DIR = "imports";
/** 旧版单文件记忆名（仅用于迁移；迁移后原文件改名保留） */
export const LEGACY_AGENT_MEMORY_FILE = "memory.md";
export const AGENT_SKILLS_DIR = "skills";
/** 子 agent 团队目录：`<agent 目录>/team/<子 agent 名>/SPEC.md`（specs/subagent-team） */
export const AGENT_TEAM_DIR = "team";
/** 每个子 agent 的声明文件名（YAML frontmatter + 正文） */
export const AGENT_TEAM_SPEC_FILE = "SPEC.md";
/** 心跳内容文件：心跳任务把它当请求交给 agent（design D11/D12） */
export const AGENT_HEARTBEAT_FILE = "HEARTBEAT.md";

/** 共享技能池目录名（列 agent 时跳过，对齐 design D8） */
export const SHARED_SKILLS_DIR = "_shared";

/** 纯函数：按环境变量算出 agents 根绝对路径（未配置 → 默认路径） */
export function resolveAgentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[AGENTS_ROOT_ENV]?.trim();
  return path.resolve(raw && raw.length > 0 ? raw : path.join(os.homedir(), "open-assistant-agents"));
}

/** 当前生效的 agents 根绝对路径 */
export function getAgentsRoot(): string {
  return resolveAgentsRoot();
}

/** 某个 agent 定义的目录绝对路径 */
export function agentDirPath(agentId: string, root: string = getAgentsRoot()): string {
  return path.join(root, agentId);
}

/** 某个 agent 的团队目录绝对路径（`<agents 根>/<id>/team`） */
export function teamDirPath(agentId: string, root: string = getAgentsRoot()): string {
  return path.join(agentDirPath(agentId, root), AGENT_TEAM_DIR);
}

/** 按需创建 agents 根目录（首次使用创建根目录） */
export async function ensureAgentsRoot(): Promise<string> {
  const root = getAgentsRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}