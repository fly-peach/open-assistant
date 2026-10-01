"use client";

import React, { useState } from "react";
import useSWR from "swr";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";

import { listTree, type WorkspaceEntry } from "@/lib/workspaceApi";
import { getPreviewType } from "@/app/utils/preview";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

/** 选中态用暖色强调（与截图一致）；未选中按文件类型着色 */
const SELECTED_TEXT = "text-[#b45309]";
const SELECTED_ICON = "text-[var(--color-warning)]";

function EntryIcon({
  entry,
  expanded,
  selected = false,
}: {
  entry: WorkspaceEntry;
  expanded: boolean;
  selected?: boolean;
}) {
  if (entry.type === "directory") {
    const cls = cn("shrink-0", selected ? SELECTED_ICON : "text-[var(--color-warning)]");
    return expanded ? <FolderOpen size={15} className={cls} /> : <Folder size={15} className={cls} />;
  }
  if (selected) return <FileIcon size={15} className={cn("shrink-0", SELECTED_ICON)} />;
  const type = getPreviewType(entry.name);
  if (type === "json") return <FileJson size={15} className="shrink-0 text-[#b45309]" />;
  if (type === "markdown") return <FileText size={15} className="shrink-0 text-[#2563eb]" />;
  if (type === "image") return <FileImage size={15} className="shrink-0 text-[#7c3aed]" />;
  if (type === "code") return <FileCode2 size={15} className="shrink-0 text-[#047857]" />;
  return <FileIcon size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />;
}

interface TreeLevelProps {
  workspacePath: string;
  rel: string;
  depth: number;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

/** 一个目录的一层内容（懒加载：只在展开/进入时请求这一层） */
function TreeLevel({ workspacePath, rel, depth, revision, selectedPath, onOpenFile }: TreeLevelProps) {
  const { data, error, isLoading } = useSWR(
    ["tree", workspacePath, rel, revision],
    () => listTree(workspacePath, rel),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const entries = data?.entries ?? [];
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (error) {
    return (
      <p className="py-1 pr-2 text-xs text-[var(--color-error)]" style={indent}>
        {t(zh.files.loadFailed, { error: String((error as Error).message ?? error) })}
      </p>
    );
  }
  if (!data && isLoading) {
    return (
      <p className="flex items-center gap-1.5 py-1 text-xs text-[var(--color-text-tertiary)]" style={indent}>
        <Loader2 size={12} className="animate-spin" />
        {zh.files.loadingDir}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="py-1 pr-2 text-xs text-[var(--color-text-tertiary)]" style={indent}>
        {zh.files.emptyDir}
      </p>
    );
  }

  return (
    <>
      {entries.map((entry) =>
        entry.type === "directory" ? (
          <DirEntry
            key={entry.path}
            workspacePath={workspacePath}
            entry={entry}
            depth={depth}
            revision={revision}
            selectedPath={selectedPath}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileEntry
            key={entry.path}
            entry={entry}
            depth={depth}
            selected={selectedPath === entry.path}
            onOpenFile={onOpenFile}
          />
        )
      )}
    </>
  );
}

function DirEntry({
  workspacePath,
  entry,
  depth,
  revision,
  selectedPath,
  onOpenFile,
}: {
  workspacePath: string;
  entry: WorkspaceEntry;
  depth: number;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const containsSelected = selectedPath?.startsWith(`${entry.path}/`) ?? false;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        aria-expanded={expanded}
        title={entry.name}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        <EntryIcon entry={entry} expanded={expanded} selected={containsSelected} />
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      {expanded && (
        <TreeLevel
          workspacePath={workspacePath}
          rel={entry.path}
          depth={depth + 1}
          revision={revision}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

function FileEntry({
  entry,
  depth,
  selected,
  onOpenFile,
}: {
  entry: WorkspaceEntry;
  depth: number;
  selected: boolean;
  onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(entry.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] hover:bg-[var(--color-surface)]",
        selected
          ? cn("bg-[#f59e0b]/10 font-medium", SELECTED_TEXT)
          : "text-[var(--color-text-primary)]"
      )}
      style={{ paddingLeft: `${depth * 12 + 26}px` }}
      title={entry.name}
      data-file-path={entry.path}
      data-file-selected={selected ? "1" : "0"}
    >
      <EntryIcon entry={entry} expanded={false} selected={selected} />
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
}

interface FileTreeProps {
  workspacePath: string;
  /** 根相对路径（分类页签用）；默认整个工作区根 */
  rootRel?: string;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

/**
 * 懒加载文件树（对齐 specs/file-workspace-ui「文件树」与 design.md Decisions #8）。
 *
 * 每层目录只在展开时请求一层（`GET /workspace/tree?path=<ws>&rel=…`），
 * 目录优先排序由后端保证；因此工作区里存在超大目录也不会在打开侧边栏时卡住。
 * `rootRel` 让「工作区 / 知识库」等分类页签只浏览对应子树，根节点本身不再单列一行
 * （工作区名由左侧的目录卡片承载）。
 */
export function FileTree({
  workspacePath,
  rootRel = "/",
  revision,
  selectedPath,
  onOpenFile,
}: FileTreeProps) {
  return (
    <div className="flex flex-col gap-0.5" data-file-tree-root={rootRel}>
      <TreeLevel
        workspacePath={workspacePath}
        rel={rootRel}
        depth={0}
        revision={revision}
        selectedPath={selectedPath}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

export default FileTree;