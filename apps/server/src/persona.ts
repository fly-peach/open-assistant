/**
 * 人设装载（对齐 specs/agent-core「助手人设装载」）。
 *
 * 人设来源只有一个：工作区根下的 `AGENTS.md`（见 design.md Decision #9：不拆 PROFILE/SOUL/MEMORY）。
 * - 文件存在 → 作为 `<persona>` 段落追加进系统提示词（身份与风格以它为准）
 * - 文件缺失 / 读取失败 → 回退内置默认人设，MUST NOT 因此拒绝服务
 *
 * 每次模型调用前重读一次（文件很小），因此：
 * - 用户用普通文本编辑器改完人设，下一个会话 / 下一轮就生效，无需重启（spec「人设修改后的生效时机」）；
 * - 不需要把内容塞进 checkpoint 状态，避免人设改了但状态里还是旧值。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SystemMessage } from "@langchain/core/messages";

import { PERSONA_FILE } from "./workspace.js";

/** 人设文件读取上限：超过时截断（人设不该是大部头，避免把上下文吃光） */
export const PERSONA_MAX_BYTES = 32 * 1024;

/**
 * 读取工作区人设文件。不存在 / 读不出来 / 空文件 → null（调用方回退默认人设）。
 */
export async function readPersona(workspaceDir: string): Promise<string | null> {
  try {
    const full = path.join(path.resolve(workspaceDir), PERSONA_FILE);
    const buf = await fs.readFile(full);
    if (buf.byteLength === 0) return null;
    const text = buf.subarray(0, PERSONA_MAX_BYTES).toString("utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** 把工作区人设作为 `<persona>` 段落追加到系统消息末尾（不覆盖内置的基础行为准则） */
export function withPersona(systemMessage: SystemMessage, persona: string): SystemMessage {
  const section = [
    "<persona>",
    `以下是用户在 ${PERSONA_FILE} 中写入的我的人设。它描述的身份、定位、语气与长期偏好优先于上面关于身份和风格的默认说法；`,
    "其中的工具用法与工作区约束与上面的规则一致，冲突时以上面更严格的那条为准。",
    "",
    persona,
    "</persona>",
  ].join("\n");

  const existing = systemMessage.content;
  const blocks =
    typeof existing === "string"
      ? [{ type: "text" as const, text: existing }]
      : Array.isArray(existing)
        ? [...existing]
        : [];
  return new SystemMessage({ content: [...blocks, { type: "text" as const, text: section }] });
}