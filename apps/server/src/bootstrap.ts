/**
 * 首次引导（对齐 specs/agent-core「首次交互引导」，tasks 9.6 / 9.7）。
 *
 * 机制抄 QwenPaw 的 `BootstrapHook`，文件体系仍只有两件套：
 * - 触发条件：`BOOTSTRAP.md` 存在 **且** `.bootstrap_completed` 不存在 **且** 是首次用户交互
 * - 动作：把引导指示拼到**本轮用户消息前**，随后立即写 `.bootstrap_completed` 防重
 * - 结束：助手把人设写进 `AGENTS.md` 后自己删掉 `BOOTSTRAP.md`
 *
 * 为什么拼在本轮用户消息前而不是写进系统提示词：写进系统提示词会永久生效，
 * 引导就成了甩不掉的"人设"（spec「引导内容不污染系统提示词」）。
 *
 * 侵入点见 `workspace-middleware.ts`：用 LangGraph 中间件的 `wrapModelCall`（本项目没有 AgentScope 那种
 * pre-reasoning hook），只在**发给模型的那一份消息**上做拼接，不回写 state，
 * 因此对话历史与界面都不会出现这段引导文本。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import {
  BOOTSTRAP_FILE,
  PERSONA_FILE,
  workspaceBootstrapFlagPath,
  workspaceMaterialPath,
} from "./workspace.js";

/** 注入到本轮用户消息前的引导指示（中文，指向 `AGENTS.md`，不提 PROFILE/SOUL/MEMORY） */
export const BOOTSTRAP_GUIDANCE = `# 引导模式

工作区里存在 \`${BOOTSTRAP_FILE}\` —— 这是我们的第一次见面。

1. 先读 \`${BOOTSTRAP_FILE}\`，按它的剧本友好地打个招呼，别端着。
2. 和用户一起把"我叫什么、我是你的什么、我用什么语气说话"聊清楚。
3. 用 \`persona_write\` 工具把结论写进 \`${PERSONA_FILE}\`（人设文件，以后每次会话都会读它并生效）。
4. 写完确认无误后，用 \`delete\` 工具删掉 \`${BOOTSTRAP_FILE}\`，引导就结束了。

如果用户不想聊身份、直接问别的，就正常回答他的问题，别反复纠缠。

---

`;

/** 首次用户交互：只有一条用户消息、且还没有任何助手回复（对齐 QwenPaw 的判定） */
export function isFirstUserInteraction(messages: readonly BaseMessage[]): boolean {
  const userCount = messages.filter((m) => HumanMessage.isInstance(m)).length;
  const assistantCount = messages.filter((m) => AIMessage.isInstance(m)).length;
  return userCount === 1 && assistantCount === 0;
}

/**
 * 把引导拼到**最后一条用户消息**前面，返回新数组（不改动原消息对象，避免污染 state）。
 * 同时兼容字符串内容与分块内容。
 */
export function prependGuidance(
  messages: readonly BaseMessage[],
  guidance: string,
): BaseMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const msg = out[i]!;
    if (!HumanMessage.isInstance(msg)) continue;
    const human = msg as HumanMessage;
    const content = human.content;
    let next: HumanMessage["content"];
    if (typeof content === "string") {
      next = guidance + content;
    } else if (Array.isArray(content)) {
      let patched = false;
      next = content.map((block) => {
        if (patched) return block;
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          patched = true;
          return {
            ...(block as Record<string, unknown>),
            text: guidance + String((block as { text?: unknown }).text ?? ""),
          } as (typeof content)[number];
        }
        return block;
      });
      if (!patched) next = [{ type: "text", text: guidance }, ...content];
    } else {
      next = guidance;
    }
    out[i] = new HumanMessage({
      content: next,
      additional_kwargs: human.additional_kwargs,
      ...(human.id ? { id: human.id } : {}),
      ...(human.name ? { name: human.name } : {}),
    });
    break;
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 是否应当注入引导：`BOOTSTRAP.md` 存在 且 防重标记不存在。
 * 是否「首次用户交互」由调用方另行判定。
 */
export async function shouldInjectBootstrap(workspaceDir: string): Promise<boolean> {
  const [hasBootstrap, hasFlag] = await Promise.all([
    exists(workspaceMaterialPath(workspaceDir, BOOTSTRAP_FILE)),
    exists(workspaceBootstrapFlagPath(workspaceDir)),
  ]);
  return hasBootstrap && !hasFlag;
}

/**
 * 首次引导是否仍在进行中：`BOOTSTRAP.md` 还住在工作区里。
 * 这是「人设写入窗口」的唯一判据（见 persona-tools.ts 的 persona_write）。
 */
export async function isBootstrapActive(workspaceDir: string): Promise<boolean> {
  return exists(workspaceMaterialPath(workspaceDir, BOOTSTRAP_FILE));
}

/**
 * 占地写入防重标记：`wx` 旗标保证同一工作区并发下只有一个调用能成功。
 * 返回 true 表示本次调用赢得了注入权。
 */
export async function claimBootstrapTrigger(workspaceDir: string): Promise<boolean> {
  const flagPath = workspaceBootstrapFlagPath(workspaceDir);
  try {
    await fs.mkdir(path.dirname(flagPath), { recursive: true });
    await fs.writeFile(
      flagPath,
      `triggeredAt: ${new Date().toISOString()}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return false;
    // 标记写不进去（权限 / 磁盘）：不阻断本次引导，但记一条日志便于排查重复注入
    console.warn(`[bootstrap] 无法写入防重标记 ${flagPath}（${code}）：${(err as Error).message}`);
    return true;
  }
}