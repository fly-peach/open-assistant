"use client";

/**
 * 二级导航：智能体长期记忆树（任务 11.18，对齐 design.md D12）。
 *
 * 两个来源合起来才是完整清单：
 * - **核心记忆**（`MEMORY.md`）：永远在最上面，走旧端点 `/agents/{id}/memory`
 *   （可读可写）—— 即使后端的分层清单接口还没就绪，核心记忆也不会在界面上消失；
 * - **分层文件**：`GET /agents/{id}/memory/tree` 返回的扁平清单（日记 / 主题笔记 /
 *   消化产物 / 外部导入），失败时给出可读错误态而不是静默空树。
 *
 * 空状态：清单为空（或后端未就绪）时提示「按日记忆与消化产物由心跳任务生成」。
 */
import React, { useMemo } from "react";
import { Loader2, MemoryStick } from "lucide-react";
import zh, { t } from "@/i18n/zh";
import { useAgentMemoryTree } from "@/app/hooks/useAgents";
import {
  buildMemoryNodes,
  normalizeMemoryEntries,
  withCoreMemoryNode,
  type MemoryNode,
} from "@/app/utils/memoryTree";
import {
  MemoryKindBadge,
  MemoryTreeRows,
} from "@/app/components/memory/MemoryTreeRows";

/** 核心长期记忆的固定 rel（与后端端点 `/agents/{id}/memory` 对应）。 */
export const AGENT_CORE_REL = "/MEMORY.md";

interface AgentMemoryTreeProps {
  agentId: string;
  revision: number;
  selectedRel: string | null;
  onSelectFile: (rel: string) => void;
}

export function AgentMemoryTree({
  agentId,
  revision,
  selectedRel,
  onSelectFile,
}: AgentMemoryTreeProps) {
  const { data, error, isLoading } = useAgentMemoryTree(agentId, revision);

  const nodes = useMemo<MemoryNode[]>(() => {
    const layered = buildMemoryNodes(normalizeMemoryEntries(data));
    return withCoreMemoryNode(layered, AGENT_CORE_REL);
  }, [data]);

  return (
    <div
      className="py-1"
      data-agent-memory-tree
    >
      <MemoryTreeRows
        nodes={nodes}
        selectedRel={selectedRel}
        onSelectFile={onSelectFile}
        renderTrailing={(node) => <MemoryKindBadge rel={node.rel} />}
      />

      {isLoading && !data && (
        <p className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-text-tertiary)]">
          <Loader2
            size={12}
            className="animate-spin"
          />
          {zh.common.loading}
        </p>
      )}

      {error != null && (
        <div
          className="mx-1 mt-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
          data-agent-memory-tree-error
        >
          <p className="text-[var(--color-error)]">
            {t(zh.memory.treeFailed, {
              error: error instanceof Error ? error.message : String(error),
            })}
          </p>
          <p className="mt-1">{zh.memory.treeFailedHint}</p>
        </div>
      )}

      {error == null && !isLoading && nodes.length <= 1 && (
        <div
          className="mx-1 mt-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
          data-agent-memory-tree-empty
        >
          <p className="flex items-center gap-1 text-[var(--color-text-secondary)]">
            <MemoryStick size={12} />
            {zh.memory.treeEmpty}
          </p>
          <p className="mt-1">{zh.memory.treeEmptyHint}</p>
        </div>
      )}
    </div>
  );
}

export default AgentMemoryTree;