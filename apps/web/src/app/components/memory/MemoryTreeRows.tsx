"use client";

/**
 * 二级导航：记忆 / wiki 的目录树（任务 11.18）。
 *
 * 复用 `FileTree` 的体验：目录行是折叠开关、文件行是选择项，逐层缩进。
 * 与 `FileTree` 的差别在于数据源是**已经拿到的嵌套节点**（agent 记忆来自
 * `/agents/{id}/memory/tree` 的扁平清单 + `buildMemoryNodes`），因此这里不自己取数。
 */
import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileJson,
  FileText,
  File as FileIcon,
  Folder,
  FolderOpen,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import zh from "@/i18n/zh";
import {
  memoryRelKind,
  type MemoryKind,
  type MemoryNode,
} from "@/app/utils/memoryTree";

/** 分层徽标（核心 / 日记 / 主题 / 消化 / 导入）；`other` 不显示。 */
const KIND_LABEL: Record<MemoryKind, string> = {
  core: zh.memory.coreBadge,
  daily: zh.memory.dailyBadge,
  topic: zh.memory.topicBadge,
  digest: zh.memory.digestBadge,
  imports: zh.memory.importsBadge,
  other: "",
};

export function MemoryKindBadge({ rel }: { rel: string }) {
  const kind = memoryRelKind(rel);
  const label = KIND_LABEL[kind];
  if (!label) return null;
  return (
    <span
      className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]"
      data-memory-kind-badge={kind}
    >
      {label}
    </span>
  );
}

function EntryIcon({ node, expanded }: { node: MemoryNode; expanded: boolean }) {
  if (node.type === "dir") {
    return expanded ? (
      <FolderOpen size={15} className="shrink-0 text-[var(--color-warning)]" />
    ) : (
      <Folder size={15} className="shrink-0 text-[var(--color-warning)]" />
    );
  }
  const name = node.name.toLowerCase();
  if (name.endsWith(".json")) {
    return <FileJson size={15} className="shrink-0 text-[#b45309]" />;
  }
  if (name.endsWith(".md") || name.endsWith(".markdown")) {
    return <FileText size={15} className="shrink-0 text-[#2563eb]" />;
  }
  return <FileIcon size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />;
}

export interface MemoryTreeRowsProps {
  nodes: MemoryNode[];
  /** 已选中的文件 rel。 */
  selectedRel: string | null;
  onSelectFile: (rel: string) => void;
  /** 目录默认是否展开（记忆树较小，默认全展开）。 */
  defaultExpanded?: boolean;
  /** 行上额外标注（如 wiki 的 raw 只读）。 */
  renderTrailing?: (node: MemoryNode) => React.ReactNode;
  /**
   * 目录展开时渲染子级：默认渲染 `node.children`；
   * 传入后由调用方负责（wiki 树用它做逐层懒加载，子级还没拿到）。
   */
  renderDirChildren?: (node: MemoryNode, depth: number) => React.ReactNode;
  depth?: number;
}

export function MemoryTreeRows({
  nodes,
  selectedRel,
  onSelectFile,
  defaultExpanded = true,
  renderTrailing,
  renderDirChildren,
  depth = 0,
}: MemoryTreeRowsProps) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "dir" ? (
          <MemoryDirRow
            key={node.rel}
            node={node}
            depth={depth}
            defaultExpanded={defaultExpanded}
            selectedRel={selectedRel}
            onSelectFile={onSelectFile}
            renderTrailing={renderTrailing}
            renderDirChildren={renderDirChildren}
          />
        ) : (
          <MemoryFileRow
            key={node.rel}
            node={node}
            depth={depth}
            selected={selectedRel === node.rel}
            onSelectFile={onSelectFile}
            renderTrailing={renderTrailing}
          />
        )
      )}
    </>
  );
}

interface RowShared {
  node: MemoryNode;
  depth: number;
  onSelectFile: (rel: string) => void;
  renderTrailing?: (node: MemoryNode) => React.ReactNode;
}

interface DirRowShared extends RowShared {
  defaultExpanded: boolean;
  selectedRel: string | null;
  renderDirChildren?: (node: MemoryNode, depth: number) => React.ReactNode;
}

function RowTrailing({ node, renderTrailing }: Pick<RowShared, "node" | "renderTrailing">) {
  const trailing = renderTrailing?.(node) ?? null;
  if (!trailing) return null;
  return <span className="ml-auto flex shrink-0 items-center gap-1">{trailing}</span>;
}

/** 只读标记（wiki 的 `raw/` 与其中的文件）。 */
export function ReadOnlyMark({ label }: { label: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]"
      data-memory-readonly={label}
      title={label}
    >
      <Lock size={9} />
      {label}
    </span>
  );
}

function MemoryDirRow({
  node,
  depth,
  defaultExpanded,
  selectedRel,
  onSelectFile,
  renderTrailing,
  renderDirChildren,
}: DirRowShared) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div data-memory-tree-dir={node.rel}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={node.name}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        <EntryIcon node={node} expanded={expanded} />
        <span className="min-w-0 truncate">{node.name}</span>
        <RowTrailing node={node} renderTrailing={renderTrailing} />
      </button>
      {expanded &&
        (renderDirChildren ? (
          renderDirChildren(node, depth + 1)
        ) : (
          <MemoryTreeRows
            nodes={node.children}
            selectedRel={selectedRel}
            onSelectFile={onSelectFile}
            defaultExpanded={defaultExpanded}
            renderTrailing={renderTrailing}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function MemoryFileRow({
  node,
  depth,
  selected,
  onSelectFile,
  renderTrailing,
}: RowShared & { selected: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.rel)}
      className={cn(
        "flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-[var(--color-surface)]",
        selected && "bg-[var(--color-surface)] font-medium"
      )}
      style={{ paddingLeft: `${depth * 12 + 16}px` }}
      title={node.name}
      data-memory-tree-item={node.rel}
      data-memory-tree-selected={selected ? "true" : "false"}
    >
      <EntryIcon node={node} expanded={false} />
      <span className="min-w-0 truncate">{node.name}</span>
      <RowTrailing node={node} renderTrailing={renderTrailing} />
    </button>
  );
}

export default MemoryTreeRows;