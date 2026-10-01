"use client";

import React, { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { Copy, Download, Eye, Loader2, Text } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { toast } from "sonner";

import { readWorkspaceFile } from "@/lib/workspaceApi";
import {
  formatSize,
  getLanguage,
  getPreviewType,
  isTodoFile,
  toImageSrc,
} from "@/app/utils/preview";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { JsonView } from "@/app/components/workspace/JsonView";
import { TodoView } from "@/app/components/workspace/TodoView";
import zh from "@/i18n/zh";
import { cn } from "@/lib/utils";

interface FilePreviewProps {
  workspacePath: string;
  /** 工作区相对路径（以 / 开头）。 */
  path: string;
  /** 刷新计数：自增时重新拉取内容（agent 改动后自动反映）。 */
  revision: number;
  onFileChanged: () => void;
}

type ViewMode = "preview" | "source";

/** 触发浏览器下载（文本按文本存，base64 按二进制解出） */
function downloadFile(content: string, encoding: string, name: string, mimeType: string): void {
  const blob =
    encoding === "base64"
      ? new Blob([Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0))], { type: mimeType })
      : new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 文件预览分流（对齐 specs/file-workspace-ui「按文件类型渲染」与 design.md Decisions #7）。
 * 复用基座已装的 react-syntax-highlighter / react-markdown，不引入 Monaco。
 * `todos.json` 走 TODO 专用视图。工具栏提供「预览 / 源码」切换、复制与下载。
 */
export function FilePreview({
  workspacePath,
  path,
  revision,
  onFileChanged,
}: FilePreviewProps) {
  const isTodo = isTodoFile(path);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");

  const { data, error, isLoading } = useSWR(
    isTodo ? null : ["file", workspacePath, path, revision],
    () => readWorkspaceFile(workspacePath, path),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const fileType = data ? getPreviewType(data.name || path, data.mimeType) : null;
  // 图片/二进制没有有意义的「源码」视图，不显示切换
  const canToggle = data != null && fileType !== "image" && fileType !== "unsupported";

  const handleCopy = useCallback(() => {
    if (data?.content) {
      void navigator.clipboard?.writeText(data.content);
      toast.success(zh.common.copied);
    }
  }, [data?.content]);

  const handleDownload = useCallback(() => {
    if (!data) return;
    downloadFile(data.content, data.encoding, data.name || "file", data.mimeType);
  }, [data]);

  const preview = useMemo(() => {
    if (!data) return null;
    const type = fileType ?? getPreviewType(data.name || path, data.mimeType);
    if (type === "image") {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={toImageSrc(data.content, data.encoding, data.mimeType)}
          alt={data.name}
          className="max-h-[70vh] max-w-full rounded-md border border-border object-contain"
        />
      );
    }
    if (viewMode === "source") {
      return (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-3 font-mono text-xs leading-6">
          {data.content}
        </pre>
      );
    }
    if (type === "markdown") {
      return (
        <div className="rounded-md bg-[var(--color-surface)] p-4">
          <MarkdownContent content={data.content} />
        </div>
      );
    }
    if (type === "code") {
      return (
        <SyntaxHighlighter
          language={getLanguage(data.name || path)}
          style={oneDark}
          showLineNumbers
          wrapLines
          wrapLongLines
          customStyle={{
            margin: 0,
            borderRadius: "0.5rem",
            fontSize: "0.8125rem",
          }}
        >
          {data.content}
        </SyntaxHighlighter>
      );
    }
    if (type === "text") {
      return (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-3 font-mono text-xs leading-6">
          {data.content}
        </pre>
      );
    }
    if (type === "json") {
      return <JsonView content={data.content} />;
    }
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-sm text-[var(--color-text-secondary)]">
        <p className="font-medium text-[var(--color-text-primary)]">{zh.files.unsupported}</p>
        <p className="mt-1">{zh.files.unsupportedHint}</p>
        {data.size > 0 && (
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{formatSize(data.size)}</p>
        )}
      </div>
    );
  }, [data, path, fileType, viewMode]);

  if (isTodo) {
    return (
      <TodoView
        workspacePath={workspacePath}
        revision={revision}
        onChanged={onFileChanged}
      />
    );
  }

  if (error) {
    return (
      <div className="p-3 text-sm text-[var(--color-error)]">
        {zh.files.readFailed.replace("{error}", String((error as Error).message ?? error))}
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-[var(--color-text-secondary)]">
        <Loader2 size={14} className="animate-spin" />
        {zh.common.loading}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-preview-path={path}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-xs text-[var(--color-text-secondary)]"
            title={path}
          >
            {path.replace(/^\//, "")}
          </div>
          <div className="truncate text-[10px] text-[var(--color-text-tertiary)]">
            {[formatSize(data?.size), data?.modifiedAt].filter(Boolean).join(" · ")}
          </div>
        </div>

        {canToggle && (
          <div
            className="flex shrink-0 items-center rounded-md border border-border p-0.5"
            role="tablist"
            aria-label={zh.files.viewModeLabel}
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "preview"}
              onClick={() => setViewMode("preview")}
              data-view-mode="preview"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                viewMode === "preview"
                  ? "bg-[#f59e0b]/12 font-medium text-[#b45309]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
              )}
            >
              <Eye size={12} />
              {zh.files.viewPreview}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "source"}
              onClick={() => setViewMode("source")}
              data-view-mode="source"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
                viewMode === "source"
                  ? "bg-[#f59e0b]/12 font-medium text-[#b45309]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
              )}
            >
              <Text size={12} />
              {zh.files.viewSource}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          aria-label={zh.common.copy}
          title={zh.common.copy}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          aria-label={zh.files.download}
          title={zh.files.download}
        >
          <Download size={13} />
        </button>
      </div>

      {data?.truncated && (
        <p className="border-b border-border bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-warning)]">
          {zh.files.truncated}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">{preview}</div>
    </div>
  );
}

export default FilePreview;