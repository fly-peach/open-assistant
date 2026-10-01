"use client";

import React, { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { AlertTriangle, Check, Circle, Loader2, Sparkles } from "lucide-react";
import {
  WorkspaceApiError,
  getWorkspaceStatus,
  initWorkspace,
  type WorkspaceStatus,
} from "@/lib/workspaceApi";
import {
  initFileItems,
  initHint,
  initResultLines,
} from "@/app/utils/workspaceInit";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

interface WorkspaceInitCardProps {
  workspacePath: string;
  /** 变更计数：初始化成功后自增，让文件树与状态一起重新拉取。 */
  revision: number;
  /** 初始化成功后调用（刷新文件树 + 触发状态复校）。 */
  onInitialized: () => void;
}

function errorText(err: unknown): string {
  const message =
    err instanceof WorkspaceApiError
      ? err.message
      : String((err as Error)?.message ?? err);
  return message;
}

/**
 * 「初始化工作区」入口（tasks 9.9 / 9.10 / 9.11；design.md Decision #9）。
 *
 * - 选定目录后**不写任何文件**：本组件只是入口，只有用户点击才调用 `POST /workspace/init`；
 * - 只有 `initialized === false` 时才渲染；两件套齐备后入口消失（9.9 / 9.10）；
 * - 点击前就说明会写入哪些文件，并逐项标出 `AGENTS.md` / `BOOTSTRAP.md` 的现状（9.9）；
 * - 点击后刷新文件树并提示「新建了哪些 / 跳过了哪些」，然后复校状态使入口消失（9.10）；
 * - 失败时展示可读错误且可重试，**不改变工作区可用性**（对话框不受影响，9.11）。
 */
export function WorkspaceInitCard({
  workspacePath,
  revision,
  onInitialized,
}: WorkspaceInitCardProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 切换工作区时清掉上一个目录的错误（错误不应跨目录残留）。
  useEffect(() => {
    setActionError(null);
  }, [workspacePath]);

  const { data, error, isLoading, mutate } = useSWR(
    ["workspace-status", workspacePath, revision],
    () => getWorkspaceStatus(workspacePath),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  const handleInit = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await initWorkspace(workspacePath);
      // 文件树与状态一起刷新（入口随状态复校后消失）。
      onInitialized();
      await mutate();
      const lines = initResultLines(result.created ?? [], result.skipped ?? []);
      toast.success(zh.workspace.initSuccess, { description: lines.join("\n") });
    } catch (err) {
      // 9.11：失败可见、可重试，不影响继续对话。
      setActionError(t(zh.workspace.initFailed, { error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  }, [workspacePath, onInitialized, mutate]);

  // 状态未知（后端未就绪 / 网络失败）：给出可读提示但**不展示初始化入口**，
  // 避免在没有把握时宣称「会写入什么」；提示也不阻断对话。
  if (error) {
    return (
      <div
        data-testid="workspace-init-status-error"
        className="space-y-1 border-b border-border px-3 py-2 text-[11px] text-[var(--color-warning)]"
      >
        <p className="flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {t(zh.workspace.initStatusFailed, { error: errorText(error) })}
          </span>
        </p>
        <p className="text-[var(--color-text-tertiary)]">
          {zh.workspace.initStatusHint}
        </p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
        <Loader2 size={12} className="animate-spin" />
        {zh.common.loading}
      </div>
    );
  }

  const status: WorkspaceStatus = data;
  // 9.9：已初始化则不再展示入口。
  if (status.initialized) return null;

  const items = initFileItems(status);

  return (
    <div
      data-testid="workspace-init-card"
      className="space-y-2 border-b border-border bg-[var(--color-surface)] px-3 py-2"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Sparkles size={13} className="shrink-0 text-[var(--color-primary)]" />
        {zh.workspace.initTitle}
      </p>
      <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        {zh.workspace.initSummary}
      </p>
      <p
        data-testid="workspace-init-hint"
        className="text-[11px] leading-relaxed text-[var(--color-text-primary)]"
      >
        {initHint(status)}
      </p>

      <div className="space-y-1">
        <p className="text-[11px] text-[var(--color-text-tertiary)]">
          {zh.workspace.initWillWrite}
        </p>
        {items.map((item) => (
          <div
            key={item.name}
            data-testid={`workspace-init-file-${item.exists ? "exists" : "missing"}`}
            className="flex items-center gap-1.5 text-[11px]"
          >
            {item.exists ? (
              <Check size={12} className="shrink-0 text-[#047857]" />
            ) : (
              <Circle size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
            )}
            <span className="font-mono">{item.name}</span>
            <span className="text-[var(--color-text-secondary)]">
              （{item.role}）
            </span>
            <span
              className={cn(
                "ml-auto shrink-0",
                item.exists
                  ? "text-[#047857]"
                  : "text-[var(--color-text-tertiary)]"
              )}
            >
              {item.exists ? zh.workspace.initFileExists : zh.workspace.initFileMissing}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        data-testid="workspace-init-button"
        onClick={() => void handleInit()}
        disabled={busy}
        aria-label={zh.workspace.initButton}
        className="flex items-center gap-1.5 rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Sparkles size={12} />
        )}
        {busy ? zh.workspace.initButtonBusy : zh.workspace.initButton}
      </button>

      {actionError && (
        <div
          data-testid="workspace-init-error"
          className="space-y-1.5 rounded border border-[var(--color-error)] px-2 py-1.5 text-[11px] text-[var(--color-error)]"
        >
          <p>{actionError}</p>
          <button
            type="button"
            onClick={() => void handleInit()}
            disabled={busy}
            className="rounded border border-border px-2 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] disabled:opacity-50"
          >
            {zh.workspace.initRetry}
          </button>
        </div>
      )}
    </div>
  );
}

export default WorkspaceInitCard;