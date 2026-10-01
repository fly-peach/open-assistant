"use client";

import React, { useCallback, useMemo, useState } from "react";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { basename } from "@/app/utils/path";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

interface WorkspaceSidebarProps {
  onClose: () => void;
}

interface PendingSwitch {
  path: string;
  create: boolean;
}

/** 文件浏览的分类页签（只浏览对应子树） */
const SCOPES: Array<{ key: string; label: string }> = [
  { key: "/", label: zh.files.scopeWorkspace },
  { key: "/wiki", label: zh.files.scopeWiki },
];

/** 小图标按钮 */
function IconButton({
  onClick,
  title,
  children,
  disabled,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      className="rounded-md p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * 右侧工作区面板：两栏文件浏览器（左＝文件列表，右＝文件内容）。
 *
 * 对齐 specs/file-workspace-ui 与 specs/workspace「工作区与对话绑定」：
 * - 工作区是用户在本机选中的一个**目录绝对路径**（design.md Decision #3）；
 * - 顶部「配置目录」卡片展示当前工作区名与完整路径（过长中间省略 + hover 看全文）；
 * - 左栏：目录卡片 → 分类页签（工作区 / 知识库）→ 文件树；
 * - 右栏：打开文件页签 → 预览（预览 / 源码、复制、下载）；未打开文件时展示工作区设置（绑定 / 初始化）；
 * - 未选择工作区时展示引导性空状态，绝不展示其他工作区的文件。
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

  const [scope, setScope] = useState<string>("/");
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);

  const otherRecents = useMemo(
    () => recentWorkspaces.filter((item) => item !== workspacePath),
    [recentWorkspaces, workspacePath]
  );

  const resetOpenFiles = useCallback(() => {
    setOpenPaths([]);
    setActivePath(null);
    setScope("/");
  }, []);

  const openFile = useCallback((path: string) => {
    setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActivePath(path);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      const idx = openPaths.indexOf(path);
      const next = openPaths.filter((item) => item !== path);
      setOpenPaths(next);
      if (activePath === path) {
        setActivePath(next[Math.min(idx, next.length - 1)] ?? null);
      }
    },
    [openPaths, activePath]
  );

  const cycleTab = useCallback(
    (delta: number) => {
      if (openPaths.length === 0) return;
      const idx = activePath ? openPaths.indexOf(activePath) : 0;
      const next = (idx + delta + openPaths.length) % openPaths.length;
      setActivePath(openPaths[next] ?? null);
    },
    [openPaths, activePath]
  );

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
          resetOpenFiles();
        } catch (err) {
          toast.error(workspaceErrorText(next, err));
        }
      })();
    },
    [workspacePath, threadId, openWorkspace, resetOpenFiles]
  );

  const confirmSwitch = useCallback(async () => {
    if (!pendingSwitch) return;
    const target = pendingSwitch;
    setPendingSwitch(null);
    try {
      await openWorkspace(target.path, target.create);
      resetOpenFiles();
    } catch (err) {
      toast.error(workspaceErrorText(target.path, err));
    }
  }, [pendingSwitch, openWorkspace, resetOpenFiles]);

  const handleRefresh = useCallback(() => {
    notifyWorkspaceChanged();
  }, [notifyWorkspaceChanged]);

  return (
    <div
      className="flex h-full min-h-0 flex-col border-l border-border bg-background"
      data-workspace-panel
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#f59e0b]/12 text-[var(--color-warning)]">
          <FolderTree size={15} />
        </span>
        <span className="text-sm font-semibold">{zh.files.panelTitle}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={zh.common.close}
          title={zh.common.close}
          className="ml-auto rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
        >
          <X size={15} />
        </button>
      </header>

      {legacyValue && (
        <div className="border-b border-border bg-[var(--color-surface)] px-3 py-2 text-xs">
          <p className="flex items-start gap-1.5 text-[var(--color-warning)]">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t(zh.workspace.legacyNotice, { value: legacyValue })}</span>
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
        <div className="flex min-h-0 flex-1" data-workspace-browser>
          {/* ── 左栏：文件列表 ── */}
          <aside className="flex w-[248px] min-w-[196px] shrink-0 flex-col border-r border-border bg-[var(--color-surface)]">
            {/* 配置目录卡片 */}
            <div className="p-2">
              <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#f59e0b]/12 text-[var(--color-warning)]">
                  <FolderTree size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] leading-tight text-[var(--color-text-tertiary)]">
                    {zh.files.configDir}
                  </p>
                  <p
                    className="truncate text-xs font-semibold text-[var(--color-text-primary)]"
                    title={workspacePath}
                  >
                    {basename(workspacePath)}
                  </p>
                  <PathLabel
                    path={workspacePath}
                    max={24}
                    tail={12}
                    className="text-[10px] text-[var(--color-text-secondary)]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  disabled={isOpening}
                  aria-label={zh.workspace.changeDir}
                  title={zh.workspace.changeDir}
                  className="shrink-0 rounded-md p-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] disabled:opacity-50"
                >
                  {isOpening ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
              </div>

              <div className="mt-1.5 flex items-center gap-1">
                <IconButton onClick={handleRefresh} title={zh.workspace.refresh}>
                  <RefreshCw size={13} />
                </IconButton>
                <IconButton onClick={() => setPickerOpen(true)} title={zh.workspace.changeDir}>
                  <FolderOpen size={13} />
                </IconButton>
                <IconButton
                  onClick={() => {
                    setWorkspacePath(null);
                    resetOpenFiles();
                  }}
                  title={zh.workspace.clear}
                >
                  <X size={13} />
                </IconButton>
              </div>

              {pendingSwitch && (
                <div className="mt-1.5 rounded-md border border-[var(--color-warning)] bg-background p-2 text-xs">
                  <p className="flex items-start gap-1.5 text-[var(--color-warning)]">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>{zh.workspace.switchWarning}</span>
                  </p>
                  <PathLabel
                    path={pendingSwitch.path}
                    max={40}
                    tail={22}
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
            </div>

            {/* 分类页签 */}
            <div
              className="flex items-center gap-1 border-b border-border px-2 pb-1.5 text-xs"
              role="tablist"
              aria-label={zh.files.panelTitle}
            >
              {SCOPES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={scope === item.key}
                  onClick={() => setScope(item.key)}
                  data-scope={item.key}
                  className={cn(
                    "rounded-md px-2 py-0.5",
                    scope === item.key
                      ? "bg-[#f59e0b]/12 font-medium text-[#b45309]"
                      : "text-[var(--color-text-secondary)] hover:bg-background"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* 文件树 */}
            <div
              className="min-h-0 flex-1 overflow-auto px-1 py-1"
              data-workspace-tree-scroll
            >
              <FileTree
                workspacePath={workspacePath}
                rootRel={scope}
                revision={revision}
                selectedPath={activePath}
                onOpenFile={openFile}
              />
            </div>

            {otherRecents.length > 0 && (
              <details className="border-t border-border px-2 py-1 text-xs">
                <summary className="cursor-pointer text-[var(--color-text-secondary)]">
                  {zh.workspace.recent}
                </summary>
                <div className="mt-1 space-y-0.5 pb-1">
                  {otherRecents.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => requestSwitch(item)}
                      title={item}
                      className="w-full min-w-0 rounded px-1 py-0.5 text-left hover:bg-background"
                    >
                      <PathLabel
                        path={item}
                        max={34}
                        tail={18}
                        className="text-[11px] text-[var(--color-text-secondary)]"
                      />
                    </button>
                  ))}
                </div>
              </details>
            )}
          </aside>

          {/* ── 右栏：打开文件页签 + 内容 ── */}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {openPaths.length > 0 ? (
              <>
                <div className="flex items-center gap-1 border-b border-border px-2 pt-1">
                  <div
                    className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
                    role="tablist"
                    aria-label={zh.files.panelTitle}
                  >
                    {openPaths.map((path) => {
                      const active = path === activePath;
                      return (
                        <div
                          key={path}
                          className={cn(
                            "group flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-2 py-1 text-xs",
                            active
                              ? "border-[var(--color-warning)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
                              : "border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)]"
                          )}
                          data-open-tab={path}
                          data-open-tab-active={active ? "1" : "0"}
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setActivePath(path)}
                            className="max-w-[140px] truncate"
                            title={path}
                          >
                            {basename(path)}
                          </button>
                          <button
                            type="button"
                            onClick={() => closeFile(path)}
                            aria-label={zh.files.closeTab}
                            title={zh.files.closeTab}
                            className="rounded p-0.5 text-[var(--color-text-tertiary)] hover:bg-background hover:text-[var(--color-text-primary)]"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 pb-1">
                    <IconButton onClick={() => cycleTab(-1)} title={zh.files.prevTab}>
                      <ChevronLeft size={14} />
                    </IconButton>
                    <IconButton onClick={() => cycleTab(1)} title={zh.files.nextTab}>
                      <ChevronRight size={14} />
                    </IconButton>
                    <span
                      className="ml-0.5 rounded border border-border px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
                      title={t(zh.files.tabCount, { count: openPaths.length })}
                    >
                      {openPaths.length}
                    </span>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col" data-workspace-preview>
                  {activePath && (
                    <FilePreview
                      workspacePath={workspacePath}
                      path={activePath}
                      revision={revision}
                      onFileChanged={notifyWorkspaceChanged}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-[var(--color-text-secondary)]">
                  <p className="font-medium text-[var(--color-text-primary)]">
                    {zh.files.noOpenFileTitle}
                  </p>
                  <p className="mt-1">{zh.files.noOpenFileHint}</p>
                </div>
                <AgentBindingCard workspacePath={workspacePath} />
                <WorkspaceInitCard
                  workspacePath={workspacePath}
                  revision={revision}
                  onInitialized={notifyWorkspaceChanged}
                />
              </div>
            )}
          </section>
        </div>
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
          resetOpenFiles();
        }}
      />
    </div>
  );
}

export default WorkspaceSidebar;