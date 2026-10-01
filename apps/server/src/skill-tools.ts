/**
 * agent 的技能工具：`skill_list` / `skill_read`（渐进披露，对齐 specs/agent-skills 与 design D8）。
 *
 * 为什么必须有这两个工具：技能存在 **agents 根下**（`<agent>/skills/` 与共享池 `_shared/skills/`），
 * 而 agent 的文件工具被沙箱限制在工作区内 —— 没有专门工具，agent 碰不到自己的技能。
 *
 * 分工（渐进披露）：
 * - 系统提示词里只放技能的**名称 + 用途**（见 persona.ts 的 `withAgentSkills`，每轮固定成本）；
 * - 正文按需用 `skill_read` 读取 —— 技能再多也不会撑爆上下文。
 */
import { tool } from "langchain";
import { z } from "zod";

import { readBinding } from "./binding.js";
import { agentDirPath } from "./agents/root.js";
import { resolveAgentRuntime } from "./agents/registry.js";
import { listEffectiveSkills, readSkillContent } from "./agents/skills.js";
import { errorText, workspaceDirOf } from "./tool-runtime.js";

/** 解析「本工作区绑定的 agent」的技能上下文（目录 + 被关闭的技能名） */
async function agentSkillContext(
  runtime: unknown,
): Promise<{ dir: string; disabled: string[] }> {
  const workspaceDir = await workspaceDirOf(runtime);
  const binding = await readBinding(workspaceDir);
  if (!binding?.agentId) {
    throw new Error(
      "当前工作区尚未绑定 agent：技能属于 agent，请先在「工作区 → 选择 agent」里完成绑定",
    );
  }
  const def = await resolveAgentRuntime(binding.agentId);
  return { dir: agentDirPath(binding.agentId), disabled: def?.config.disabledSkills ?? [] };
}

export const skillListTool = tool(
  async (_args, runtime) => {
    try {
      const { dir, disabled } = await agentSkillContext(runtime);
      const skills = (await listEffectiveSkills(dir, { disabled })).filter((s) => !s.disabled);
      if (skills.length === 0) return "当前没有可用技能。";
      return JSON.stringify(
        {
          note: "以下是可用技能的名称与用途；需要时用 skill_read 读取完整说明。",
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            source: s.source,
            overridden: s.overridesShared ? "覆盖了同名共享技能" : undefined,
          })),
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "skill_list",
    description:
      "列出我当前可用的技能（名称 + 用途）。当任务可能对应某个既有技能时，先用它确认，再决定用哪个。",
    schema: z.object({}),
  },
);

export const skillReadTool = tool(
  async ({ name }, runtime) => {
    try {
      const { dir, disabled } = await agentSkillContext(runtime);
      const skill = (await listEffectiveSkills(dir, { disabled })).find((s) => s.name === name);
      if (!skill) {
        return `ERROR [SKILL_NOT_FOUND] 没有名为 ${name} 的技能（可用 skill_list 看有哪些）`;
      }
      if (skill.disabled) {
        return `ERROR [SKILL_DISABLED] 技能 ${name} 已被关闭，暂不可用（需要时让用户在 agent 配置里打开）`;
      }
      const content = await readSkillContent(skill.dir);
      if (!content) {
        return `ERROR [SKILL_EMPTY] 技能 ${name} 的 SKILL.md 不存在或为空`;
      }
      return content;
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "skill_read",
    description:
      "读取某个技能的完整说明（SKILL.md 正文），并据此执行。名称来自 skill_list 的结果。",
    schema: z.object({ name: z.string().describe("技能名") }),
  },
);

export const skillTools = [skillListTool, skillReadTool];