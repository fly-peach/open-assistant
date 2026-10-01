/**
 * agent 技能：元信息扫描 + **两级继承**（共享池 → agent 私有，同名私有优先）。
 *
 * 目录约定（对齐 Anthropic Agent Skills / design D8）：
 *   <agents 根>/_shared/skills/<skill-name>/SKILL.md   共享技能（新 agent 继承）
 *   <agents 根>/<agent-id>/skills/<skill-name>/SKILL.md 该 agent 私有技能
 *
 * 渐进披露由 `skill-tools.ts`（`skill_list` / `skill_read`）与
 * `withAgentSkills`（只注入 name + description）共同实现：本文件只负责「有哪些技能」。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AGENT_SKILLS_DIR, sharedSkillsDirPath } from "./root.js";

export type AgentSkillSource = "agent" | "shared";

export interface AgentSkillMeta {
  name: string;
  description: string;
  /** 技能目录绝对路径（内部用；HTTP 契约里只暴露 name/description 等） */
  dir: string;
  /** 来源：agent 私有 / 共享池 */
  source: AgentSkillSource;
  /** 该技能是否被本 agent 关闭（agent 配置的 disabledSkills） */
  disabled: boolean;
  /** 该 agent 私有技能覆盖了同名共享技能 */
  overridesShared: boolean;
}

/** 技能名需是安全的目录名（不含分隔符、不以 . 开头、长度受限） */
export function isValidSkillName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (name.length === 0 || name.length > 64) return false;
  if (name.startsWith(".")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** 解析 SKILL.md 开头的 YAML frontmatter（只取 name / description，够用且无依赖） */
function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return result;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]!] = value;
  }
  return result;
}

/** 读取单个技能目录的 SKILL.md 全文；不存在 / 读不出 → null */
export async function readSkillContent(skillDir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** 读取单个技能目录的元信息（导入技能时用它拿 frontmatter 里的 name） */
export async function readSkillMetaFromDir(
  skillDir: string,
  source: AgentSkillSource = "agent",
): Promise<AgentSkillMeta | null> {
  return readSkillMeta(skillDir, source);
}

async function readSkillMeta(
  skillDir: string,
  source: AgentSkillSource,
): Promise<AgentSkillMeta | null> {
  const text = await readSkillContent(skillDir);
  if (text === null) return null; // 没有 SKILL.md 的目录不是技能
  const meta = parseFrontmatter(text);
  const name = (meta["name"] ?? path.basename(skillDir)).trim();
  if (name.length === 0) return null;
  return {
    name,
    description: (meta["description"] ?? "").trim(),
    dir: skillDir,
    source,
    disabled: false,
    overridesShared: false,
  };
}

/** 扫描一个技能目录下的全部技能（按 name 排序；目录不存在 → 空数组） */
export async function listSkillsInDir(
  skillsDir: string,
  source: AgentSkillSource,
): Promise<AgentSkillMeta[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.resolve(skillsDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: AgentSkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readSkillMeta(path.join(path.resolve(skillsDir), entry.name), source);
    if (meta) skills.push(meta);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * agent 的**生效技能**：共享池 + agent 私有，同名时私有覆盖共享（并标注覆盖）。
 * `disabled` 来自 agent 配置的 `disabledSkills`。
 */
export async function listEffectiveSkills(
  agentDir: string,
  options: { disabled?: readonly string[]; sharedRoot?: string } = {},
): Promise<AgentSkillMeta[]> {
  const disabled = new Set(options.disabled ?? []);
  const shared = await listSkillsInDir(sharedSkillsDirPath(options.sharedRoot), "shared");
  const own = await listSkillsInDir(path.join(path.resolve(agentDir), AGENT_SKILLS_DIR), "agent");

  const byName = new Map<string, AgentSkillMeta>();
  for (const skill of shared) byName.set(skill.name, skill);
  for (const skill of own) {
    // 同名时私有覆盖共享：标记私有技能「覆盖了共享」，共享技能不再出现在生效列表
    if (byName.get(skill.name)?.source === "shared") skill.overridesShared = true;
    byName.set(skill.name, skill);
  }

  return [...byName.values()]
    .map((skill) => ({ ...skill, disabled: disabled.has(skill.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名取一条生效技能（`skill_read` 用） */
export async function findEffectiveSkill(
  agentDir: string,
  name: string,
  options: { disabled?: readonly string[]; sharedRoot?: string } = {},
): Promise<AgentSkillMeta | null> {
  const skills = await listEffectiveSkills(agentDir, options);
  return skills.find((skill) => skill.name === name) ?? null;
}