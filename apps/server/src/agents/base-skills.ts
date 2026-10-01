/**
 * 基础技能（共享技能池的种子，对齐 design D8「技能来源两级」）。
 *
 * 初始化（首次使用 / 建 agent）时把这几条写进 `<agents 根>/_shared/skills/`，
 * 所有 agent **继承**它们；用户可以在共享池里扩充，或在某个 agent 的 `skills/` 下
 * 放同名技能来覆盖。
 *
 * 只种一份、不覆盖：用户改过（或删过）的内容不会被下次初始化冲掉。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { sharedSkillsDirPath } from "./root.js";

export interface BaseSkill {
  /** 技能名（= 目录名，需为安全的目录名） */
  name: string;
  /** 一行用途描述（进系统提示词的就是这一行） */
  description: string;
  /** 正文（按需读取） */
  body: string;
}

export const BASE_SKILLS: BaseSkill[] = [
  {
    name: "note-taking",
    description: "把零散信息整理成工作区里的文件（笔记 / 摘要 / 清单），而不是只留在对话里",
    body: `
# 把信息落成文件

对话会被压缩，文件不会。用户给出值得留存的信息（决定、结论、参考资料、清单）时，
把它整理成工作区里的 markdown 文件。

## 怎么做

1. **先想清楚放哪**：默认放 \`notes/\`；与某个主题相关就放对应子目录（如 \`notes/health/\`）。
2. **一个主题一个文件**：文件名用简短、能一眼看懂的标题，不要用日期当唯一标识。
3. **只写要点**：结论在前，细节在后；不要原文照抄整段对话。
4. **已有文件就补充**：同一主题再次出现时用 \`edit_file\` 追加，不要新建重复文件。
5. 写完用一句话告诉用户「写到了哪个文件的哪一节」。

## 不要

- 不要把用户的私密内容（密钥、口令）写进文件。
- 不要为了「完整性」把大段无关内容也搬进去。
`.trim(),
  },
  {
    name: "todo-management",
    description: "维护待办清单：什么时候建、怎么更新状态、怎么和用户对齐事实源",
    body: `
# 维护待办

待办是工作区里的 \`todos.json\`，人和 agent 共用同一份事实源 —— 改动会立刻在界面上可见。

## 工具

- \`todo_list\` 查看（开始处理多步任务前先看一遍）
- \`todo_create\` 新建
- \`todo_update\` 更新（状态 / 内容）
- \`todo_delete\` 删除

## 约定

1. **多步任务先拆**：面对 3 步以上的任务，先建成待办再逐步执行，每完成一步就更新状态。
2. **状态如实**：\`pending\` / \`in_progress\` / \`completed\` 要反映真实进度，不要提前标完成。
3. **不重复建**：建之前先 \`todo_list\` 看一眼，同一件事不要开两条。
4. **拿到事实再动手**：用户只给了模糊描述时，先问清楚或去读文件确认，不要猜着建。
`.trim(),
  },
  {
    name: "project-wiki",
    description: "维护项目知识库（wiki/）：收录原始材料、沉淀结论、保持索引与图谱一致",
    body: `
# 维护项目知识库

工作区里的 \`wiki/\` 是这个项目长期沉淀下来的知识：原始材料、结论、以及它们之间的关系。

## 目录约定

- \`wiki/raw/\` —— 原始材料（网页、文档、摘录），尽量不加工
- \`wiki/summaries/\` —— 对原始材料的消化结论
- \`wiki/entities/\` —— 人 / 项目 / 概念等实体页
- \`wiki/SCHEMA.md\` —— 实体类型与字段约定（先读它再写实体页）
- \`wiki/index.md\` —— 内容目录
- \`wiki/log.md\` —— 时间线

## 约定

1. **先读 SCHEMA.md**：写实体页前先看该目录的字段约定，别自造字段。
2. **原始与结论分开**：原始材料进 \`raw/\`，你的判断进 \`summaries/\`，不要把两者混在一页。
3. **一处事实源**：同一个结论只写在最合适的那一页，别处用链接引用。
4. **保持索引**：新增页面后把入口补到 \`index.md\`。
`.trim(),
  },
];

/** `SKILL.md` 的完整内容（frontmatter + 正文） */
export function renderSkillFile(name: string, description: string, body: string): string {
  const frontmatter = ["---", `name: ${name}`, `description: ${description.replace(/\s+/g, " ").trim()}`, "---"];
  return `${frontmatter.join("\n")}\n\n${body.trim()}\n`;
}

export async function statOrNull(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/**
 * 幂等播种基础技能到共享池：已存在的技能目录**不覆盖**（用户可能改过）。
 * 返回本次新建的技能名。
 */
export async function ensureBaseSkills(root?: string): Promise<string[]> {
  const dir = sharedSkillsDirPath(root);
  await fs.mkdir(dir, { recursive: true });
  const created: string[] = [];
  for (const skill of BASE_SKILLS) {
    const skillDir = path.join(dir, skill.name);
    if (await statOrNull(path.join(skillDir, "SKILL.md"))) continue;
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      renderSkillFile(skill.name, skill.description, skill.body),
      "utf8",
    );
    created.push(skill.name);
  }
  return created;
}