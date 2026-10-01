import type { Thread } from "@langchain/langgraph-sdk";
import useSWRInfinite from "swr/infinite";

import { listWorkspaceSessions } from "@/lib/sessionsApi";
import { sessionToThreadItem, type ThreadItem } from "@/app/utils/sessionView";
import zh from "@/i18n/zh";

export type { ThreadItem };

const DEFAULT_PAGE_SIZE = 20;

/**
 * 会话列表：**记录来自工作区会话库**（`GET /workspace/sessions`），平台只提供热会话实时状态。
 *
 * 因为工作区 ↔ agent 是 1:1，按工作区列出即「不同 agent 各自的会话入口」。
 * 未选工作区时不查询（没有归属就无从列出）。
 *
 * `status` 只作兼容保留：状态过滤由 `ThreadList` 在客户端做（会话库列表很小），
 * 不再下推到执行引擎。
 */
export function useThreads(props: {
  status?: Thread["status"];
  limit?: number;
  workspace?: string | null;
}) {
  const pageSize = props.limit || DEFAULT_PAGE_SIZE;
  const workspace = props.workspace ?? null;

  return useSWRInfinite(
    (pageIndex: number, previousPageData: ThreadItem[] | null) => {
      if (!workspace) return null;
      // 上一页为空 → 已到末尾
      if (previousPageData && previousPageData.length === 0) return null;
      return { kind: "sessions" as const, pageIndex, pageSize, workspace };
    },
    async ({
      pageIndex,
      pageSize,
      workspace,
    }: {
      kind: "sessions";
      pageIndex: number;
      pageSize: number;
      workspace: string;
    }) => {
      const sessions = await listWorkspaceSessions(workspace, {
        limit: pageSize,
        offset: pageIndex * pageSize,
      });
      return sessions.map((session) => sessionToThreadItem(session, zh.threadList.untitled));
    },
    {
      revalidateFirstPage: true,
      revalidateOnFocus: true,
    }
  );
}