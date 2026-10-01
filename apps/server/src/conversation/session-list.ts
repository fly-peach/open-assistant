/**
 * 会话列表的「热冷合并」——会话库是记录来源，平台提供实时状态与待导入的历史。
 *
 * - **冷（记录）**：`<工作区>/.open-assistant/sessions.sqlite` 里的会话（列表单位、可检索、跟着工作区走）
 * - **热（状态）**：平台里还活着的 thread，带 `idle / busy / interrupted / error` 实时状态
 * - **导入**：平台上有、会话库里还没有的 thread（本功能上线前的历史会话）补一行记录，
 *   使它们在按会话库驱动的列表里依然可见（`title` 取首条用户消息）
 *
 * 平台查询失败不致命：降级为「只列会话库里的记录、无实时状态」。
 */
import { Client, type Thread } from "@langchain/langgraph-sdk";

import { readBinding, readSessionOwners } from "../binding.js";
import { getLangGraphApiUrl, WORKSPACE_METADATA_KEY } from "../sessions.js";
import { createThread, defaultTitleFromUserContent, listSessions, threadExists } from "./store.js";
import type { ThreadSummary } from "./types.js";

/** 平台 thread 状态（与前端 `Thread["status"]` 一致） */
export type LiveStatus = "idle" | "busy" | "interrupted" | "error";

export interface WorkspaceSessionItem extends ThreadSummary {
  /** 平台实时状态；会话库里没有对应热 thread 时为 null（纯冷会话） */
  liveStatus: LiveStatus | null;
}

export interface ListWorkspaceSessionsOptions {
  limit?: number;
  offset?: number;
  /** 从平台一次拉取的上限（导入 + 状态叠加都用它） */
  platformLimit?: number;
  /** 注入平台客户端（测试用）；默认按 `apiUrl` 新建 */
  client?: Client;
  apiUrl?: string;
}

function isLiveStatus(value: unknown): value is LiveStatus {
  return value === "idle" || value === "busy" || value === "interrupted" || value === "error";
}

/** 平台 thread 的首条用户输入（用于生成导入时的默认标题） */
function firstHumanText(thread: Thread): string | null {
  const messages = (thread.values as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return null;
  for (const entry of messages) {
    const record = entry as { type?: unknown; content?: unknown };
    if (record?.type !== "human") continue;
    const content = record.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("");
    }
    return "";
  }
  return null;
}

/**
 * 列出某工作区的会话（含非活跃，按最近活动倒序），叠加平台实时状态。
 * 副作用：把平台上尚未落库的 thread 导入会话库（幂等，只补缺）。
 */
export async function listWorkspaceSessions(
  workspaceDir: string,
  options: ListWorkspaceSessionsOptions = {},
): Promise<WorkspaceSessionItem[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const platformLimit = options.platformLimit ?? 200;

  // 1) 平台侧：本工作区的 thread（状态 + 待导入历史）。失败降级为空。
  let platform: Thread[] = [];
  try {
    const client = options.client ?? new Client({ apiUrl: options.apiUrl ?? getLangGraphApiUrl() });
    platform = await client.threads.search({
      metadata: { [WORKSPACE_METADATA_KEY]: workspaceDir },
      limit: platformLimit,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
  } catch {
    platform = [];
  }

  // 2) 导入：平台上还没有落库的 thread 补一行会话记录（历史会话因此不会消失）
  if (platform.length > 0) {
    const owners = await readSessionOwners(workspaceDir).catch(
      () => ({}) as Record<string, string>,
    );
    const fallbackAgent =
      (await readBinding(workspaceDir).catch(() => null))?.agentId ?? "unknown";
    for (const thread of platform) {
      if (threadExists(workspaceDir, thread.thread_id)) continue;
      const human = firstHumanText(thread);
      createThread(workspaceDir, {
        id: thread.thread_id,
        agentId: owners[thread.thread_id] ?? fallbackAgent,
        kind: "main",
        title: human === null || human.length === 0 ? null : defaultTitleFromUserContent(human),
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        status: thread.status === "error" ? "error" : "active",
      });
    }
  }

  // 3) 记录来源：工作区会话库
  const summaries = listSessions(workspaceDir, { limit, offset });

  // 4) 叠加实时状态（热会话才有；纯冷会话为 null）
  const live = new Map<string, LiveStatus>();
  for (const thread of platform) {
    if (isLiveStatus(thread.status)) live.set(thread.thread_id, thread.status);
  }
  return summaries.map((summary) => ({
    ...summary,
    liveStatus: live.get(summary.id) ?? null,
  }));
}