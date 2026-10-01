/**
 * 人设装载（对齐 specs/agent-registry「人设装载」）。
 *
 * ## 三档优先级（本组新增，tasks 1.7）
 *
 * 1. `<agents 根>/<agent-id>/AGENTS.md` —— agent 定义（正式来源）
 * 2. `<工作区>/AGENTS.md` —— **过渡期回退**（旧工作区还没把 AGENTS.md 迁到 agent 时的兼容层，见 migration 9.2）
 * 3. 内置默认 —— 上面两档都没有时，保持 graph 的基础系统提示词（即内置默认人设），不回退到任何人
 *
 * - 文件存在 → 作为 `<persona>` 段落追加进系统提示词（身份与风格以它为准）
 * - 文件缺失 / 读取失败 → 进入下一档，MUST NOT 因此拒绝服务
 *
 * 每次模型调用前重读一次（文件很小），因此：
 * - 用户用普通文本编辑器改完人设，下一个会话 / 下一轮就生效，无需重启；
 * - 不需要把内容塞进 checkpoint 状态，避免人设改了但状态里还是旧值。
 *
 * 三档的判定结果带 `tier` 返回，测试与 probe 可据此断言「到底走了哪一档」。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SystemMessage } from "@langchain/core/messages";

import { PERSONA_FILE } from "./workspace.js";
import { PERSONA_CONTENT } from "./workspace-materials.js";
import { AGENT_PERSONA_FILE } from "./agents/root.js";
import type { AgentSkillMeta } from "./agents/skills.js";

/** 人设文件读取上限：超过时截断（人设不该是大部头，避免把上下文吃光） */
export const PERSONA_MAX_BYTES = 32 * 1024;

/**
 * 内置默认人设内容：新建 agent 时写进它的 `AGENTS.md`（默认 agent「小助」也用它）。
 *
 * 与「第 3 档回退」的区别：第 3 档不注入任何 `<persona>` 段落，直接用 graph 的基础
 * 系统提示词（agent.ts 的 SYSTEM_PROMPT）；这个常量是**可编辑的初始人设文件内容**，
 * 让新 agent 一建出来就有一份看得见、改得动的定位说明。
 */
export const DEFAULT_AGENT_PERSONA = PERSONA_CONTENT;

/** 读取某个目录下的指定文件；不存在 / 空文件 / 读不出来 → null */
export async function readPersonaFile(dir: string, fileName: string): Promise<string | null> {
  try {
    const full = path.join(path.resolve(dir), fileName);
    const buf = await fs.readFile(full);
    if (buf.byteLength === 0) return null;
    const text = buf.subarray(0, PERSONA_MAX_BYTES).toString("utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 读取工作区人设文件。不存在 / 读不出来 / 空文件 → null（调用方回退默认人设）。
 */
export async function readPersona(workspaceDir: string): Promise<string | null> {
  return readPersonaFile(workspaceDir, PERSONA_FILE);
}

export type PersonaTier = "agent" | "workspace" | "builtin";

export interface LoadedPersona {
  /** 命中的内容；`builtin` 档为 null（表示「不注入、用基础系统提示词」） */
  content: string | null;
  tier: PersonaTier;
}

/**
 * 按三档优先级装载人设。
 * - `agentDir`：已绑定 agent 的定义目录（未绑定 / 未解析到时传 null）
 * - `workspaceDir`：当前 run 的工作区目录
 */
export async function loadPersona(options: {
  agentDir?: string | null | undefined;
  workspaceDir?: string | null | undefined;
}): Promise<LoadedPersona> {
  if (options.agentDir) {
    const agentPersona = await readPersonaFile(options.agentDir, AGENT_PERSONA_FILE);
    if (agentPersona) return { content: agentPersona, tier: "agent" };
  }
  if (options.workspaceDir) {
    const workspacePersona = await readPersona(options.workspaceDir);
    if (workspacePersona) return { content: workspacePersona, tier: "workspace" };
  }
  return { content: null, tier: "builtin" };
}

function appendTextBlock(systemMessage: SystemMessage, text: string): SystemMessage {
  const existing = systemMessage.content;
  const blocks =
    typeof existing === "string"
      ? [{ type: "text" as const, text: existing }]
      : Array.isArray(existing)
        ? [...existing]
        : [];
  return new SystemMessage({ content: [...blocks, { type: "text" as const, text }] });
}

/** 把 agent 人设作为 `<persona>` 段落追加到系统消息末尾（不覆盖内置的基础行为准则） */
export function withPersona(systemMessage: SystemMessage, persona: string): SystemMessage {
  const section = [
    "<persona>",
    "以下是「我是谁」的人设定义（来自 agent 定义目录里的 AGENTS.md；过渡期也可能来自工作区里的 AGENTS.md）。",
    "它描述的身份、定位、语气与长期偏好优先于上面关于身份和风格的默认说法；",
    "其中的工具用法与工作区约束与上面的规则一致，冲突时以上面更严格的那条为准。",
    "",
    persona,
    "</persona>",
  ].join("\n");
  return appendTextBlock(systemMessage, section);
}

/**
 * 把 agent 的长期记忆作为 `<agent_memory>` 段落追加到系统消息末尾。
 * 记忆跨工作区共享（design D1：`我在这干了什么` 归工作区，`关于人的记忆` 归 agent）。
 */
export function withAgentMemory(systemMessage: SystemMessage, memory: string): SystemMessage {
  const section = [
    "<agent_memory>",
    "以下是我跨工作区共享的长期记忆（来自 agent 定义目录里的 memory.md）。",
    "它记录的是关于用户的长期偏好与事实，不随当前项目变化。",
    "",
    memory.trim(),
    "</agent_memory>",
  ].join("\n");
  return appendTextBlock(systemMessage, section);
}

/**
 * 把 agent 可用技能作为 `<agent_skills>` 段落追加到系统消息末尾。
 *
 * **渐进披露**（design D8）：这里只放**名称 + 用途**（每条一行，每轮固定成本），
 * 技能正文按需用 `skill_read` 读取 —— 技能再多也不会把上下文撑爆。
 * 已关闭的技能不注入。
 */
export function withAgentSkills(
  systemMessage: SystemMessage,
  skills: readonly AgentSkillMeta[],
): SystemMessage {
  const enabled = skills.filter((skill) => !skill.disabled);
  if (enabled.length === 0) return systemMessage;
  const section = [
    "<agent_skills>",
    "以下是我可用的技能（只给了名称与用途）。当某个技能可能相关时，先用 skill_list 确认，",
    "再用 skill_read 读取它的完整说明并照做；不要凭名字猜技能内容。",
    "",
    ...enabled.map((skill) => `- ${skill.name}: ${skill.description || "（无描述）"}`),
    "</agent_skills>",
  ].join("\n");
  return appendTextBlock(systemMessage, section);
}