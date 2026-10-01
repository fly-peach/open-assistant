/**
 * agent 技能元信息扫描（tasks 1.2 / 1.4 的配套；完整技能能力见 tasks 8）。
 *
 * 本组只负责「把 agent 目录下 skills/ 里的技能列出来」（`GET /agents/{id}` 契约需要
 * `skills: [{ name, description }]`）。技能的渐进披露 / 读取工具 / 共享池优先级由 tasks 8 实现，
 * 这里刻意只做**元信息解析**，不做注入，也不碰共享池。
 *
 * 目录约定（对齐 Anthropic Agent Skills，design D8）：
 *   <agent>/skills/<skill-name>/SKILL.md   frontmatter: name / description
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AGENT_SKILLS_DIR } from "./root.js";

export interface AgentSkillMeta {
  name: string;
  description: string;
  /** 技能目录绝对路径（内部用；HTTP 契约里只暴露 name/description） */
  dir: string;
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

async function readSkillMeta(skillDir: string): Promise<AgentSkillMeta | null> {
  const skillFile = path.join(skillDir, "SKILL.md");
  let text: string;
  try {
    text = await fs.readFile(skillFile, "utf8");
  } catch {
    return null; // 没有 SKILL.md 的目录不是技能（残缺技能由 tasks 8 标注，这里直接跳过）
  }
  const meta = parseFrontmatter(text);
  const name = (meta["name"] ?? path.basename(skillDir)).trim();
  if (name.length === 0) return null;
  return { name, description: (meta["description"] ?? "").trim(), dir: skillDir };
}

/** 列出 agent 目录下的全部技能元信息（按 name 排序；目录不存在 → 空数组） */
export async function listAgentSkills(agentDir: string): Promise<AgentSkillMeta[]> {
  const skillsDir = path.join(path.resolve(agentDir), AGENT_SKILLS_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: AgentSkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readSkillMeta(path.join(skillsDir, entry.name));
    if (meta) skills.push(meta);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}