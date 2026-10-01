/**
 * agent 的记忆工具：`memory_search` / `memory_read` / `memory_note` / `memory_core`
 * （tasks 11.4–11.6，对齐 specs/agent-registry 的「检索与渐进展开」与「心跳维护记忆」）。
 *
 * 为什么必须有这些工具：**记忆存在 agents 根下，而 agent 的文件工具被沙箱限制在工作区内** ——
 * 没有专门工具，agent 根本碰不到自己的记忆。这也是「心跳任务能维护记忆」的前提：
 * 心跳把 `<agent>/HEARTBEAT.md` 当请求跑一轮，agent 靠这几个工具把要点写回去。
 *
 * 分工：
 * - `memory_search` —— **先拿片段 + 路径**（对齐 QwenPaw 的 `MEMORY_SEARCH_GUIDANCE`）
 * - `memory_read`   —— 片段不够时**按路径渐进展开**
 * - `memory_note`   —— 写当天的**主题笔记**（幂等 upsert，重复归纳不堆积），并自动刷新日记索引
 * - `memory_core`   —— 改**核心长期记忆**（append 默认，replace 需显式指定）
 */
import { tool } from "langchain";
import { z } from "zod";

import { readBinding } from "./binding.js";
import { agentDirPath } from "./agents/root.js";
import { resolveAgentRuntime } from "./agents/registry.js";
import {
  appendCoreMemory,
  localDate,
  readMemoryFile,
  searchMemory,
  upsertTopicNote,
  writeCoreMemory,
} from "./agents/memory.js";
import { errorText, workspaceDirOf } from "./tool-runtime.js";

/** 从运行上下文解析「本工作区绑定的 agent」的定义目录（工具都要用它） */
async function agentDirOf(runtime: unknown): Promise<string> {
  const workspaceDir = await workspaceDirOf(runtime);
  const binding = await readBinding(workspaceDir);
  if (!binding?.agentId) {
    throw new Error(
      "当前工作区尚未绑定 agent：记忆属于 agent，请先在「工作区 → 选择 agent」里完成绑定",
    );
  }
  // 走 registry 以便复用缓存与校验（agent 不存在时会给出可读错误）
  const def = await resolveAgentRuntime(binding.agentId);
  return def ? agentDirPath(binding.agentId) : agentDirPath(binding.agentId);
}

export const memorySearchTool = tool(
  async ({ query, limit }, runtime) => {
    try {
      const dir = await agentDirOf(runtime);
      const hits = await searchMemory(dir, query, limit ?? 8);
      if (hits.length === 0) {
        return `没有命中记忆。可以换个说法，或先用 memory_read 直接读 MEMORY.md。`;
      }
      return JSON.stringify(
        {
          note: "以下是片段与文件路径；片段不足时用 memory_read 按路径读取全文。",
          hits: hits.map((h) => ({ path: h.rel, snippet: h.snippet })),
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "memory_search",
    description:
      "检索我的长期记忆（核心记忆 + 日记忆 + 消化产物）。涉及用户过去的事实、偏好、决定或经验时先用它，" +
      "结果包含片段与文件路径；片段不够再用 memory_read 按路径展开。",
    schema: z.object({
      query: z.string().describe("检索词，空格分隔多个词（全部命中才算命中）"),
      limit: z.number().int().min(1).max(50).optional().describe("最多返回条数，默认 8"),
    }),
  },
);

export const memoryReadTool = tool(
  async ({ path: rel }, runtime) => {
    try {
      const dir = await agentDirOf(runtime);
      const read = await readMemoryFile(dir, rel);
      if (!read) {
        return `ERROR [MEMORY_FILE_NOT_FOUND] 记忆文件不存在或不可读：${rel}（可用 memory_search 找路径，或读 MEMORY.md）`;
      }
      return read.content;
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "memory_read",
    description: "按路径读取某个记忆文件的全文（路径来自 memory_search 的结果）。",
    schema: z.object({ path: z.string().describe("相对 agent 记忆目录的路径，如 MEMORY.md 或 memory/2026-10-01/话题.md") }),
  },
);

export const memoryNoteTool = tool(
  async ({ topic, content, date }, runtime) => {
    try {
      const dir = await agentDirOf(runtime);
      const day = date ?? localDate();
      const res = await upsertTopicNote(dir, day, topic, content);
      return JSON.stringify(
        {
          ok: true,
          date: day,
          path: res.rel,
          created: res.created,
          note: res.created ? "已新建当天主题笔记，并已刷新日记索引。" : "已覆盖当天同一话题的笔记（幂等，不会重复堆积）。",
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "memory_note",
    description:
      "把这次会话的要点归纳进**当天的主题笔记**（按话题命名，重复写同一话题是覆盖而非追加），" +
      "并自动刷新当天日记里的主题索引。维护记忆时主要用它。",
    schema: z.object({
      topic: z.string().describe("话题名（会作为文件名，需简短明确）"),
      content: z.string().describe("该话题的要点（markdown）"),
      date: z.string().optional().describe("YYYY-MM-DD，默认今天"),
    }),
  },
);

export const memoryCoreTool = tool(
  async ({ content, mode }, runtime) => {
    try {
      const dir = await agentDirOf(runtime);
      if (mode === "replace") {
        await writeCoreMemory(dir, content);
        return "已整体替换核心长期记忆（MEMORY.md）。";
      }
      await appendCoreMemory(dir, content);
      return "已追加到核心长期记忆（MEMORY.md）末尾，原有内容保留。";
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "memory_core",
    description:
      "改**核心长期记忆**（MEMORY.md，跨工作区共享）。默认追加，保留原有内容；" +
      "只有确认要整体重写时才用 replace。",
    schema: z.object({
      content: z.string().describe("要写入的记忆内容（markdown）"),
      mode: z.enum(["append", "replace"]).optional().describe("默认 append"),
    }),
  },
);

export const memoryTools = [
  memorySearchTool,
  memoryReadTool,
  memoryNoteTool,
  memoryCoreTool,
];