"use client";

import React, { useCallback, useMemo } from "react";
import useSWR from "swr";
import { Copy, Loader2 } from "lucide-react";
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

interface FilePreviewProps {
  workspacePath: string;
  /** 工作区相对路径（以 / 开头）。 */
  path: string;
  /** 刷新计数：自增时重新拉取内容（agent 改动后自动反映）。 */
  revision: number;
  onFileChanged: () => void;
}

/**
 * 文件预览分流（对齐 specs/file-workspace-ui「按文件类型渲染」与 design.md Decisions #7）。
 * 复用基座已装的 react-syntax-highlighter / react-markdown，不引入 Monaco。
 * `todos.json` 走 TODO 专用视图（对齐「TODO 专用视图」）。
 */
export function FilePreview({
  workspacePath,
  path,
  revision,
  onFileChanged,
}: FilePreviewProps) {
  const isTodo = isTodoFile(path);

  const { data, error, isLoading } = useSWR(
    isTodo ? null : ["file", workspacePath, path, revision],
    () => readWorkspaceFile(workspacePath, path),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const handleCopy = useCallback(() => {
    if (data?.content) {
      void navigator.clipboard?.writeText(data.content);
      toast.success(zh.common.copied);
    }
  }, [data?.content]);

  const preview = useMemo(() => {
    if (!data) return null;
    const type = getPreviewType(data.name || path, data.mimeType);
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
        <p className="font-medium text-[var(--color-text-primary)]">
          {zh.files.unsupported}
        </p>
        <p className="mt-1">{zh.files.unsupportedHint}</p>
        {data.size > 0 && (
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
            {formatSize(data.size)}
          </p>
        )}
      </div>
    );
  }, [data, path]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{data?.name || path}</div>
          <div className="text-[11px] text-[var(--color-text-tertiary)]">
            {[formatSize(data?.size), data?.modifiedAt]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          aria-label={zh.common.copy}
        >
          <Copy size={13} />
          {zh.common.copy}
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