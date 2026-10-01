/**
 * 人设写入工具 `persona_write`（tasks 9.8 的配套通道）。
 *
 * 为什么需要它，而不是直接允许 `write_file /AGENTS.md`：
 * - workspace spec 要求「agent 在常规任务中不得覆盖 / 删除人设文件」；
 * - agent-core spec 的首次引导又要求助手把确认下来的身份写进人设文件；
 * 两条要求相撞，于是把「写人设」拆成一条**显式、可审计、只在引导窗口内可用**的通道：
 * - 文件类工具（write_file / edit_file / delete）**任何时候**都不能碰 `AGENTS.md`
 *   （由 workspace-middleware 无条件拦截），所以「不能覆盖人设」永远成立；
 * - `persona_write` 只在 `BOOTSTRAP.md` 还在工作区里时可用（引导进行中）。
 *   助手删掉 `BOOTSTRAP.md` 之后，这条通道自动关闭。
 */
import fs from "node:fs/promises";
import { tool } from "langchain";
import { z } from "zod";

import { isBootstrapActive } from "./bootstrap.js";
import { errorText, workspaceDirOf } from "./tool-runtime.js";
import { BOOTSTRAP_FILE, PERSONA_FILE, workspaceMaterialPath } from "./workspace.js";

export const personaWriteTool = tool(
  async ({ content, mode }, runtime) => {
    try {
      const dir = await workspaceDirOf(runtime);
      // 唯一的开门条件：BOOTSTRAP.md 还在（首次引导进行中）
      if (!(await isBootstrapActive(dir))) {
        return (
          `ERROR [PERSONA_LOCKED] 首次引导已经结束（工作区里没有 ${BOOTSTRAP_FILE}），` +
          `不能再用本工具改人设。要改请让用户直接编辑 ${PERSONA_FILE}。`
        );
      }

      const full = workspaceMaterialPath(dir, PERSONA_FILE);
      let next = content;
      if (mode === "append") {
        const existing = await fs.readFile(full, "utf8").catch(() => "");
        next = existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n\n${content}` : content;
      }
      await fs.writeFile(full, next, "utf8");
      return JSON.stringify(
        { ok: true, path: `/${PERSONA_FILE}`, mode: mode ?? "replace", bytes: Buffer.byteLength(next) },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "persona_write",
    description:
      `把助手的人设写进工作区的 ${PERSONA_FILE}（首次设定身份用）。` +
      `只在首次引导期间可用：工作区里还有 ${BOOTSTRAP_FILE} 时才能写，引导结束（${BOOTSTRAP_FILE} 被删）后调用会返回 ERROR [PERSONA_LOCKED]。` +
      `mode=replace（默认）整体覆盖人设文件；mode=append 在现有内容后追加。` +
      `把身份写完后记得删除 ${BOOTSTRAP_FILE}，引导就结束了。`,
    schema: z.object({
      content: z.string().min(1).describe(`完整的人设内容（Markdown，中文）`),
      mode: z
        .enum(["replace", "append"])
        .optional()
        .describe("replace 整体覆盖（默认）／append 追加到现有内容之后"),
    }),
  },
);

export const personaTools = [personaWriteTool];