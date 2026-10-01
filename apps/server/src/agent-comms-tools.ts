/**
 * 跨 agent 通信工具（对齐 specs/multi-agent-comms，参照 QwenPaw 的
 * `list_agents` / `chat_with_agent`）。
 *
 * - `list_agents`：列出**我能联系**的对端（受 agent 配置的 `contactableAgents` 约束）；
 * - `ask_agent`：让对端在**它自己的工作区**里跑一轮，把答复拿回来（前台，问一句等一句）。
 *
 * 能力边界由工具白名单 `crossAgent` 组控制（默认关）；运行期还会再查一次名单。
 * 子 agent（team）不拿这两个工具（结构性防递归）。
 */
import { tool } from "langchain";
import { z } from "zod";
import { getConfig } from "@langchain/langgraph";

import { askAgent, currentCallDepth, listContactableAgents } from "./agents/comms.js";
import { errorText, workspaceDirOf } from "./tool-runtime.js";

export const listAgentsTool = tool(
  async (_args, runtime) => {
    try {
      const workspaceDir = await workspaceDirOf(runtime);
      const { callerAgentId, agents } = await listContactableAgents(workspaceDir);
      if (!callerAgentId) {
        return "ERROR [AGENT_NOT_BOUND] 当前工作区尚未绑定 agent，无法确定「我是谁」，因此列不出可联系的 agent";
      }
      if (agents.length === 0) {
        return "没有任何可联系的 agent。（在「智能体配置 → 可联系的智能体」里填上对端 id 后才能联系）";
      }
      return JSON.stringify(
        {
          note: "以下是你可以联系的对端；用 ask_agent 发消息，对端会在它自己的工作区里执行。",
          callerAgentId,
          agents,
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "list_agents",
    description:
      "列出我当前可以联系的其它 agent（受配置里的「可联系的智能体」名单约束）。" +
      "想找人帮忙/打听前先用它确认对端 id。",
    schema: z.object({}),
  },
);

export const askAgentTool = tool(
  async ({ to_agent, text, session_id }, runtime) => {
    try {
      const workspaceDir = await workspaceDirOf(runtime);
      const config = getConfig() as { configurable?: Record<string, unknown> };
      const threadId = config.configurable?.["thread_id"];
      const result = await askAgent({
        callerWorkspaceDir: workspaceDir,
        toAgentId: to_agent,
        text,
        sessionId: session_id,
        callerThreadId: typeof threadId === "string" && threadId.length > 0 ? threadId : undefined,
        depth: currentCallDepth(config),
      });
      return JSON.stringify(
        {
          note: "对端已在自己工作区里执行并把答复给你了；同一话题继续问时把 session_id 带上。",
          to_agent: result.toAgentId,
          session_id: result.sessionId,
          reply: result.reply,
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "ask_agent",
    description:
      "让另一个 agent 在它自己的工作区（用它的人设/工具/记忆）里执行一件事，并把结果答复给我。" +
      "前台等待，适合「问一句要答复」；对端 id 用 list_agents 查。",
    schema: z.object({
      to_agent: z.string().describe("对端 agent 的 id（来自 list_agents）"),
      text: z.string().describe("要说给对端的话 / 要它做的事"),
      session_id: z
        .string()
        .optional()
        .describe("续聊同一话题时传上次答复里的 session_id；不传则新开一条"),
    }),
  },
);

export const agentCommsTools = [listAgentsTool, askAgentTool];