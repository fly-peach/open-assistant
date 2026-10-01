"use client";

/**
 * 智能体 / 绑定 / 任务 / 记忆的 SWR 数据钩子。
 *
 * 关键点：
 * - **按工作区取数**：绑定、任务、项目记忆的 key 里都带工作区路径，
 *   因此切换工作区就是换 key，两个工作区的数据不会互相复用（specs/agent-scheduling「任务只在所属工作区触发」）。
 * - **错误不静默**：SWR 的 error 原样抛出给页面，页面据此展示可读错误态。
 */
import useSWR from "swr";
import {
  getAgent,
  getAgentMemory,
  getAgentMemoryFile,
  getAgentMemoryTree,
  getBinding,
  getProjectMemory,
  listAgents,
  type AgentDetail,
  type AgentSummary,
  type AgentsRoot,
} from "@/lib/agentsApi";
import { listJobs, type JobSpec } from "@/lib/jobsApi";
import { getTeam, type TeamView } from "@/lib/teamApi";
import { deriveBindingState, type BindingView } from "@/app/utils/agentConfig";

export function useAgents() {
  return useSWR<AgentsRoot>("/agents", () => listAgents());
}

export function useAgent(id: string | null) {
  return useSWR<AgentDetail>(id ? `/agents/${id}` : null, () =>
    getAgent(id as string)
  );
}

/** 工作区绑定（key 带路径 → 换工作区自动重新取数）。 */
export function useBinding(workspace: string | null) {
  return useSWR(workspace ? `/workspace/binding?path=${workspace}` : null, () =>
    getBinding(workspace as string)
  );
}

export interface BindingHook extends BindingView {
  isLoading: boolean;
  error: unknown;
  /** 已加载的智能体列表（选择器用）。 */
  agents: AgentSummary[];
  reload: () => void;
}

/** 绑定状态视图：把「读不到 / 未绑定 / 绑定的 agent 不存在」区分开。 */
export function useBindingState(workspace: string | null): BindingHook {
  const binding = useBinding(workspace);
  const agents = useAgents();
  const knownIds = agents.data ? agents.data.agents.map((item) => item.id) : null;
  const view = deriveBindingState(
    binding.data,
    knownIds,
    binding.error ?? agents.error,
    Boolean(workspace)
  );
  return {
    ...view,
    isLoading: binding.isLoading || agents.isLoading,
    error: binding.error,
    agents: agents.data?.agents ?? [],
    reload: () => {
      void binding.mutate();
      void agents.mutate();
    },
  };
}

export function useJobs(workspace: string | null) {
  return useSWR<JobSpec[]>(
    workspace ? `/jobs?path=${workspace}` : null,
    () => listJobs(workspace as string)
  );
}

export function useAgentMemory(id: string | null) {
  return useSWR<string>(id ? `/agents/${id}/memory` : null, () =>
    getAgentMemory(id as string)
  );
}

/**
 * 分层记忆的扁平清单（任务 11.18）。
 *
 * `revision` 参与 key：点「刷新」或后端写完后自增即可重新取数。
 * `shouldRetryOnError: false`：后端未就绪时只展示一次错误态，不无限重试刷屏。
 */
export function useAgentMemoryTree(id: string | null, revision = 0) {
  return useSWR<unknown>(
    id ? [`/agents/${id}/memory/tree`, revision] : null,
    () => getAgentMemoryTree(id as string),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  );
}

/** 单个记忆文件（`rel` 为空时不请求）。 */
export function useAgentMemoryFile(
  id: string | null,
  rel: string | null,
  revision = 0
) {
  return useSWR<{ rel: string; content: string }>(
    id && rel ? [`/agents/${id}/memory/file`, rel, revision] : null,
    () => getAgentMemoryFile(id as string, rel as string),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  );
}

export function useProjectMemory(workspace: string | null) {
  return useSWR<string>(
    workspace ? `/memory/project?path=${workspace}` : null,
    () => getProjectMemory(workspace as string)
  );
}

/**
 * 某个智能体的子 agent 团队（任务 2.1）。
 *
 * 与 `useAgentMemoryTree` 同款：`revision` 参与 key（刷新 / 写完后自增），
 * `shouldRetryOnError: false` 避免后端未就绪时无限重试刷屏，
 * `keepPreviousData` 让保存后的刷新不闪空列表。
 */
export function useTeam(agentId: string | null, revision = 0) {
  return useSWR<TeamView>(
    agentId ? [`/agents/${agentId}/team`, revision] : null,
    () => getTeam(agentId as string),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  );
}