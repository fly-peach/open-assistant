"use client";

import React, { useCallback, useState } from "react";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import {
  AlertTriangle,
  FolderOpen,
  FolderTree,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { FileTree } from "@/app/components/workspace/FileTree";
import { FilePreview } from "@/app/components/workspace/FilePreview";
import { DirectoryPicker } from "@/app/components/workspace/DirectoryPicker";
import { PathLabel } from "@/app/components/workspace/PathLabel";
import { WorkspaceInitCard } from "@/app/components/workspace/WorkspaceInitCard";
import { AgentBindingCard } from "@/app/components/workspace/AgentBindingCard";
import {
  useWorkspaceContext,
  workspaceErrorText,
} from "@/providers/WorkspaceProvider";
import zh, { t } from "@/i18n/zh";

interface WorkspaceSidebarProps {
  onClose: () => void;
}

interface PendingSwitch {
  path: string;
  create: boolean;
}

/**
 * 右侧工作区侧边栏（对齐 specs/file-workspace-ui「工作区侧边栏」与 specs/workspace「工作区与对话绑定」）。
 *
 * - 工作区是用户在本机选中的一个**目录绝对路径**（design.md Decision #3）；
 * - 通过「本机目录选择器」指定工作区（逐层浏览 / 直接输入绝对路径 / 新建目录）；
 * - 展示当前工作区的完整绝对路径（8.10），过长时中间省略 + hover 看全文（8.11）；
 * - 未选择工作区时展示引导性空状态，绝不展示其他工作区的文件；
 * - 切换工作区时若当前已有会话，明确提示后果（不静默混用）。
 */
export function WorkspaceSidebar({ onClose }: WorkspaceSidebarProps) {
  const {
    workspacePath,
    setWorkspacePath,
    recentWorkspaces,
    legacyValue,
    dismissLegacy,
    openWorkspace,
    isOpening,
    revision,
    notifyWorkspaceChanged,
  } = useWorkspaceContext();
  const [threadId] = useQueryState("threadId");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);

  /** 选择/切换工作区；对话中切换需先明确确认（不静默混用两个工作区）。 */
  const requestSwitch = useCallback(
    (next: string, create = false) => {
      if (next === workspacePath) return;
      if (threadId) {
        setPendingSwitch({ path: next, create });
        return;
      }
      void (async () => {
        try {
          if (create) {
            await openWorkspace(next, true);
          } else {
            await openWorkspace(next);
          }
          setSelectedPath(null);
        } catch (err) {
          toast.error(workspaceErrorText(next, err));
        }
      })();
    },
    [workspacePath, threadId, openWorkspace]
  );

  const confirmSwitch = useCallback(async () => {
    if (!pendingSwitch) return;
    const target = pendingSwitch;
    setPendingSwitch(null);
    try {
      await openWorkspace(target.path, target.create);
      setSelectedPath(null);
    } catch (err) {
      toast.error(workspaceErrorText(target.path, err));
    }
  }, [pendingSwitch, openWorkspace]);

  const handleRefresh = useCallback(() => {
    notifyWorkspaceChanged();
  }, [notifyWorkspaceChanged]);

  return (
    <div
      className="flex h-full min-h-0 flex-col border-l border-border bg-background"
      data-workspace-panel
    >
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <FolderTree size={15} className="shrink-0 text-[var(--color-text-secondary)]" />
        <span className="text-sm font-semibold">{zh.workspace.panelTitle}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-label={zh.workspace.selectDir}
            title={zh.workspace.selectDir}
            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          >
            <FolderOpen size={14} />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            aria-label={zh.workspace.refresh}
            title={zh.workspace.refresh}
            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          >
            <RefreshCw size={14} />
          </button>
          {workspacePath && (
            <button
              type="button"
              onClick={() => setWorkspacePath(null)}
              aria-label={zh.workspace.clear}
              title={zh.workspace.clear}
              className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={zh.common.close}
            title={zh.common.close}
            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {legacyValue && (
        <div className="border-b border-border bg-[var(--color-surface)] px-3 py-2 text-xs">
          <p className="flex items-start gap-1.5 text-[var(--color-warning)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {t(zh.workspace.legacyNotice, { value: legacyValue })}
            </span>
          </p>
          <button
            type="button"
            onClick={dismissLegacy}
            className="mt-1.5 rounded border border-border px-2 py-0.5"
          >
            {zh.workspace.legacyDismiss}
          </button>
        </div>
      )}

      {workspacePath === null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <p className="text-sm font-medium">{zh.workspace.emptyTitle}</p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              {zh.workspace.emptyDescription}
            </p>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs text-white"
            >
              <FolderOpen size={13} />
              {zh.workspace.selectDir}
            </button>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">
              {zh.workspace.recent}
            </p>
            {recentWorkspaces.length === 0 ? (
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {zh.workspace.recentEmpty}
              </p>
            ) : (
              <div className="space-y-1">
                {recentWorkspaces.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => requestSwitch(item)}
                    title={item}
                    className="w-full min-w-0 rounded border border-border px-2 py-1 text-left hover:bg-[var(--color-surface)]"
                  >
                    <PathLabel
                      path={item}
                      max={44}
                      tail={24}
                      className="text-[11px] text-[var(--color-text-secondary)]"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {zh.workspace.currentPath}
              </p>
              {/* 8.10 完整绝对路径 + 8.11 过长中间省略、title 看全文 */}
              <PathLabel
                path={workspacePath}
                max={56}
                tail={30}
                className="text-xs text-[var(--color-text-primary)]"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={isOpening}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
              >
                {isOpening ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FolderOpen size={12} />
                )}
                {zh.workspace.changeDir}
              </button>
            </div>
            {pendingSwitch && (
              <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] p-2 text-xs">
                <p className="flex items-start gap-1.5 text-[var(--color-warning)]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{zh.workspace.switchWarning}</span>
                </p>
                <PathLabel
                  path={pendingSwitch.path}
                  max={48}
                  tail={26}
                  className="mt-1 text-[11px] text-[var(--color-text-secondary)]"
                />
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void confirmSwitch()}
                    className="rounded bg-[var(--color-primary)] px-2 py-0.5 text-white"
                  >
                    {zh.workspace.switchConfirm}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingSwitch(null)}
                    className="rounded border border-border px-2 py-0.5"
                  >
                    {zh.workspace.switchCancel}
                  </button>
                </div>
              </div>
            )}
            {recentWorkspaces.filter((item) => item !== workspacePath).length >
              0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-[var(--color-text-secondary)]">
                  {zh.workspace.recent}
                </summary>
                <div className="mt-1.5 space-y-1">
                  {recentWorkspaces
                    .filter((item) => item !== workspacePath)
                    .map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => requestSwitch(item)}
                        title={item}
                        className="w-full min-w-0 rounded border border-border px-2 py-1 text-left hover:bg-[var(--color-surface)]"
                      >
                        <PathLabel
                          path={item}
                          max={44}
                          tail={24}
                          className="text-[11px] text-[var(--color-text-secondary)]"
                        />
                      </button>
                    ))}
                </div>
              </details>
            )}
          </div>

          {/* 5.4 / 5.5：绑定状态 + 选择/更换入口（未绑定时对话会被阻止） */}
          <div className="border-b border-border px-3 py-2">
            <AgentBindingCard workspacePath={workspacePath} />
          </div>

          {/* 9.9：选定目录后不写文件，仅在未初始化时展示「初始化」入口 */}
          <WorkspaceInitCard
            workspacePath={workspacePath}
            revision={revision}
            onInitialized={notifyWorkspaceChanged}
          />

          <div
            className="max-h-[42%] min-h-[120px] shrink-0 overflow-auto border-b border-border"
            data-workspace-tree-scroll
          >
            <FileTree
              workspacePath={workspacePath}
              revision={revision}
              selectedPath={selectedPath}
              onOpenFile={setSelectedPath}
            />
          </div>

          <div
            className="flex min-h-0 flex-1 flex-col"
            data-workspace-preview
            data-preview-path={selectedPath ?? ""}
          >
            {selectedPath ? (
              <FilePreview
                workspacePath={workspacePath}
                path={selectedPath}
                revision={revision}
                onFileChanged={notifyWorkspaceChanged}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-[var(--color-text-secondary)]">
                {zh.files.pickHint}
              </div>
            )}
          </div>
        </>
      )}

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={workspacePath}
        onSubmit={async (path, create) => {
          if (threadId && path !== workspacePath) {
            setPendingSwitch({ path, create });
            return;
          }
          await openWorkspace(path, create);
          setSelectedPath(null);
        }}
      />
    </div>
  );
}

export default WorkspaceSidebar;