"use client";

/**
 * 右侧预览：智能体记忆**非核心**文件（任务 11.18）。
 *
 * - 走新端点 `GET /agents/{id}/memory/file?rel=`；
 * - markdown 用现有的 `MarkdownContent` 渲染，json 用 `JsonView`，其余按等宽文本展示；
 * - 这些文件由 agent / 心跳任务维护，界面这里只读浏览；人工可以直接用文本编辑器修改
 *   （specs/agent-registry「人工编辑被采纳」），因此给出提示而不是「禁止编辑」；
 * - 后端未就绪（404）时展示可读错误态。
 */
import React, { useCallback } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import zh, { t } from "@/i18n/zh";
import { useAgentMemoryFile } from "@/app/hooks/useAgents";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { JsonView } from "@/app/components/workspace/JsonView";
import { getExtension } from "@/app/utils/preview";
import { memoryRelName } from "@/app/utils/memoryTree";

interface AgentMemoryFilePreviewProps {
  agentId: string;
  /** 记忆根下的相对路径（以 `/` 开头）。 */
  rel: string;
  revision: number;
}

export function AgentMemoryFilePreview({
  agentId,
  rel,
  revision,
}: AgentMemoryFilePreviewProps) {
  const { data, error, isLoading } = useAgentMemoryFile(agentId, rel, revision);
  const content = data?.content ?? "";

  const handleCopy = useCallback(() => {
    if (!content) return;
    void navigator.clipboard?.writeText(content);
    toast.success(zh.common.copied);
  }, [content]);

  if (error != null) {
    return (
      <div
        className="p-3 text-sm text-[var(--color-error)]"
        data-agent-memory-file-error
      >
        {t(zh.files.readFailed, {
          error: error instanceof Error ? error.message : String(error),
        })}
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-[var(--color-text-secondary)]">
        <Loader2
          size={14}
          className="animate-spin"
        />
        {zh.common.loading}
      </div>
    );
  }

  const ext = getExtension(memoryRelName(rel));
  const isMarkdown = ext === "md" || ext === "markdown";
  const isJson = ext === "json";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-agent-memory-file={rel}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{memoryRelName(rel)}</div>
          <div className="text-[11px] text-[var(--color-text-tertiary)]">
            {rel}
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
      <p className="border-b border-border bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
        {zh.memory.filePickHint}
      </p>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {content.length === 0 ? (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {zh.files.fileEmpty}
          </p>
        ) : isJson ? (
          <JsonView content={content} />
        ) : isMarkdown ? (
          <div className="rounded-md bg-[var(--color-surface)] p-4">
            <MarkdownContent content={content} />
          </div>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-3 font-mono text-xs leading-6">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

export default AgentMemoryFilePreview;