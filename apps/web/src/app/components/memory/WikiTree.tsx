"use client";

/**
 * 二级导航：项目 wiki 树（任务 11.18，对齐 specs/project-wiki「目录结构在文件树中可见」）。
 *
 * - wiki 就在工作区里（`<工作区>/wiki/`，design D12），因此复用**已经就绪的**
 *   `GET /workspace/tree?path=<ws>&rel=/wiki` 与 `GET /workspace/file`，不新增后端；
 * - 逐层懒加载（和 `FileTree` 一致）：展开一个目录只请求一层，`raw/` 里堆很多资料也不卡；
 * - `wiki/` 不存在时按 spec「wiki 不存在时不报错」处理成**空 wiki**（可读空状态），
 *   其他失败（网络 / 500）才展示错误态；
 * - `wiki/raw/**` 是**不可变**原始资料（spec「原始资料不可变」）：行上加只读标记。
 */
import React, { useMemo } from "react";
import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { isPathNotFound, listTree } from "@/lib/workspaceApi";
import zh, { t } from "@/i18n/zh";
import {
  buildListingNodes,
  isWikiRawRel,
  normalizeMemoryEntries,
  type MemoryNode,
} from "@/app/utils/memoryTree";
import {
  MemoryTreeRows,
  ReadOnlyMark,
} from "@/app/components/memory/MemoryTreeRows";

/** wiki 层在工作区里的根（design D12：与 todos.json 同级）。 */
export const WIKI_ROOT_REL = "/wiki";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `/workspace/tree` 的 `rel` 在 Windows 上不能用前导 `/` 的绝对形式
 * （后端对 `/wiki` 会报 `PATH_INVALID`，而 `/workspace/file` 反而接受），
 * 因此这里统一剥掉前导斜杠，只给它工作区相对路径。
 */
function treeRel(rel: string): string {
  const stripped = rel.replace(/^\/+/, "");
  return stripped.length > 0 ? stripped : "/";
}

interface WikiTreeProps {
  workspacePath: string;
  revision: number;
  selectedRel: string | null;
  onSelectFile: (rel: string) => void;
}

function TreeNotice({
  depth,
  children,
  tone = "muted",
  testId,
}: {
  depth: number;
  children: React.ReactNode;
  tone?: "muted" | "error";
  testId?: string;
}) {
  return (
    <p
      className={
        tone === "error"
          ? "py-1 text-xs text-[var(--color-error)]"
          : "py-1 text-xs text-[var(--color-text-tertiary)]"
      }
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
      data-wiki-tree-notice={testId}
    >
      {children}
    </p>
  );
}

interface WikiDirChildrenProps {
  workspacePath: string;
  rel: string;
  depth: number;
  revision: number;
  selectedRel: string | null;
  onSelectFile: (rel: string) => void;
}

function WikiDirChildren({
  workspacePath,
  rel,
  depth,
  revision,
  selectedRel,
  onSelectFile,
}: WikiDirChildrenProps) {
  const { data, error, isLoading } = useSWR(
    ["wiki-tree", workspacePath, rel, revision],
    () => listTree(workspacePath, treeRel(rel)),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const nodes = useMemo<MemoryNode[]>(
    () => buildListingNodes(normalizeMemoryEntries(data?.entries ?? []), rel),
    [data, rel]
  );

  const rawMark = (node: MemoryNode) =>
    isWikiRawRel(node.rel) ? <ReadOnlyMark label={zh.memory.rawBadge} /> : null;

  if (error != null) {
    if (isPathNotFound(error)) {
      return (
        <TreeNotice
          depth={depth}
          testId="empty"
        >
          {zh.files.emptyDir}
        </TreeNotice>
      );
    }
    return (
      <TreeNotice
        depth={depth}
        tone="error"
        testId="error"
      >
        {t(zh.memory.wikiError, { error: messageOf(error) })}
      </TreeNotice>
    );
  }

  if (isLoading && !data) {
    return (
      <TreeNotice depth={depth}>
        <span className="inline-flex items-center gap-1">
          <Loader2
            size={12}
            className="animate-spin"
          />
          {zh.files.loadingDir}
        </span>
      </TreeNotice>
    );
  }

  if (nodes.length === 0) {
    return (
      <TreeNotice
        depth={depth}
        testId="empty"
      >
        {zh.files.emptyDir}
      </TreeNotice>
    );
  }

  return (
    <MemoryTreeRows
      nodes={nodes}
      depth={depth}
      selectedRel={selectedRel}
      onSelectFile={onSelectFile}
      renderTrailing={rawMark}
      renderDirChildren={(node, childDepth) => (
        <WikiDirChildren
          workspacePath={workspacePath}
          rel={node.rel}
          depth={childDepth}
          revision={revision}
          selectedRel={selectedRel}
          onSelectFile={onSelectFile}
        />
      )}
    />
  );
}

export function WikiTree({
  workspacePath,
  revision,
  selectedRel,
  onSelectFile,
}: WikiTreeProps) {
  const { data, error, isLoading } = useSWR(
    ["wiki-tree", workspacePath, WIKI_ROOT_REL, revision],
    () => listTree(workspacePath, treeRel(WIKI_ROOT_REL)),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const nodes = useMemo<MemoryNode[]>(
    () =>
      buildListingNodes(
        normalizeMemoryEntries(data?.entries ?? []),
        WIKI_ROOT_REL
      ),
    [data]
  );

  const rawMark = (node: MemoryNode) =>
    isWikiRawRel(node.rel) ? <ReadOnlyMark label={zh.memory.rawBadge} /> : null;

  if (error != null) {
    if (isPathNotFound(error)) {
      return <WikiEmptyState testId="empty" />;
    }
    return (
      <div
        className="mx-1 mt-1 rounded border border-dashed border-border p-2 text-xs"
        data-wiki-tree-error
      >
        <p className="text-[var(--color-error)]">
          {t(zh.memory.wikiError, { error: messageOf(error) })}
        </p>
        <p className="mt-1 text-muted-foreground">{zh.memory.wikiErrorHint}</p>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <p className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-text-tertiary)]">
        <Loader2
          size={12}
          className="animate-spin"
        />
        {zh.common.loading}
      </p>
    );
  }

  if (nodes.length === 0) {
    return <WikiEmptyState testId="empty" />;
  }

  return (
    <div
      className="py-1"
      data-wiki-tree
    >
      <MemoryTreeRows
        nodes={nodes}
        selectedRel={selectedRel}
        onSelectFile={onSelectFile}
        renderTrailing={rawMark}
        renderDirChildren={(node, childDepth) => (
          <WikiDirChildren
            workspacePath={workspacePath}
            rel={node.rel}
            depth={childDepth}
            revision={revision}
            selectedRel={selectedRel}
            onSelectFile={onSelectFile}
          />
        )}
      />
    </div>
  );
}

/** 空 wiki：spec 要求「没有 wiki 目录时视为空 wiki，不报错」。 */
export function WikiEmptyState({ testId = "empty" }: { testId?: string }) {
  return (
    <div
      className="mx-1 mt-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
      data-wiki-tree-empty={testId}
    >
      <p className="text-[var(--color-text-secondary)]">{zh.memory.wikiEmpty}</p>
      <p className="mt-1">{zh.memory.wikiEmptyHint}</p>
    </div>
  );
}

export default WikiTree;