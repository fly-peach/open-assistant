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
import { basename } from "@/app/utils/path";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

function EntryIcon({ entry, expanded }: { entry: WorkspaceEntry; expanded: boolean }) {
  if (entry.type === "directory") {
    return expanded ? (
      <FolderOpen size={15} className="shrink-0 text-[var(--color-warning)]" />
    ) : (
      <Folder size={15} className="shrink-0 text-[var(--color-warning)]" />
    );
  }
  const type = getPreviewType(entry.name);
  if (type === "json") return <FileJson size={15} className="shrink-0 text-[#b45309]" />;
  if (type === "markdown")
    return <FileText size={15} className="shrink-0 text-[#2563eb]" />;
  if (type === "image")
    return <FileImage size={15} className="shrink-0 text-[#7c3aed]" />;
  if (type === "code")
    return <FileCode2 size={15} className="shrink-0 text-[#047857]" />;
  return <FileIcon size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />;
}

interface DirNodeProps {
  workspacePath: string;
  path: string;
  name: string;
  depth: number;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

function DirNode({
  workspacePath,
  path,
  name,
  depth,
  revision,
  selectedPath,
  onOpenFile,
}: DirNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);

  const { data, error, isLoading } = useSWR(
    expanded ? ["tree", workspacePath, path, revision] : null,
    () => listTree(workspacePath, path),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const entries = data?.entries ?? [];

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-[var(--color-surface)]"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        <EntryIcon entry={{ name, path, type: "directory", size: null, modifiedAt: null }} expanded={expanded} />
        <span className="min-w-0 truncate">{name}</span>
        {isLoading && <Loader2 size={12} className="ml-auto shrink-0 animate-spin" />}
      </button>

      {expanded && (
        <div>
          {error && (
            <p
              className="py-1 text-xs text-[var(--color-error)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              {t(zh.files.loadFailed, {
                error: String((error as Error).message ?? error),
              })}
            </p>
          )}
          {!error && !isLoading && entries.length === 0 && (
            <p
              className="py-1 text-xs text-[var(--color-text-tertiary)]"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              {zh.files.emptyDir}
            </p>
          )}
          {entries.map((entry) =>
            entry.type === "directory" ? (
              <DirNode
                key={entry.path}
                workspacePath={workspacePath}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                revision={revision}
                selectedPath={selectedPath}
                onOpenFile={onOpenFile}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                onClick={() => onOpenFile(entry.path)}
                className={cn(
                  "flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-[var(--color-surface)]",
                  selectedPath === entry.path &&
                    "bg-[var(--color-surface)] font-medium"
                )}
                style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
                title={entry.name}
              >
                <span className="w-[14px] shrink-0" />
                <EntryIcon entry={entry} expanded={false} />
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

interface FileTreeProps {
  workspacePath: string;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

/**
 * 懒加载文件树（对齐 specs/file-workspace-ui「文件树」与 design.md Decisions #8）。
 *
 * 每层目录只在展开时请求一层（`GET /workspace/tree?path=<ws>&rel=…`），
 * 目录优先排序由后端保证；因此工作区里存在超大目录也不会在打开侧边栏时卡住。
 */
export function FileTree({
  workspacePath,
  revision,
  selectedPath,
  onOpenFile,
}: FileTreeProps) {
  return (
    <div className="flex flex-col py-1">
      <DirNode
        workspacePath={workspacePath}
        path="/"
        name={basename(workspacePath)}
        depth={0}
        revision={revision}
        selectedPath={selectedPath}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

export default FileTree;