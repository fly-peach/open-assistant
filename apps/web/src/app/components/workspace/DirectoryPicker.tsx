"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  MoveRight,
  RefreshCw,
  Undo2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listFsDir, listFsRoots, pickNativeFolder } from "@/lib/workspaceApi";
import {
  isAbsolutePath,
  joinPath,
  pathBreadcrumbs,
  type PathCrumb,
} from "@/app/utils/path";
import { PathLabel } from "@/app/components/workspace/PathLabel";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 已确认选择：由上层调用 `openWorkspace`（`path` 为绝对路径，
   * `create = true` 表示目录尚不存在、由后端创建）。抛出异常时选择器展示可读错误。
   */
  onSubmit: (path: string, create: boolean) => Promise<void>;
  /** 打开时的起始目录（通常是当前工作区）。 */
  initialPath?: string | null;
}

/**
 * 本机目录选择器（tasks 8.9，对齐 specs/workspace「本机目录浏览与选择」）。
 *
 * - 「磁盘与根目录」起步，可逐层进入子目录（只列目录 + 面包屑 + 上一级）；
 * - 可直接输入绝对路径并「前往」（无需逐层浏览）；
 * - 可在当前目录下新建目录并选用；
 * - 目录不可访问时给出提示且能返回上一级，不整体失败；
 * - 顶部与输入框都展示当前目录的完整绝对路径。
 */
export function DirectoryPicker({
  open,
  onOpenChange,
  onSubmit,
  initialPath,
}: DirectoryPickerProps) {
  /** null 表示「磁盘与根目录」视图。 */
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 打开时定位到当前工作区（若有），否则从磁盘/根开始。
  useEffect(() => {
    if (!open) return;
    const start = initialPath && isAbsolutePath(initialPath) ? initialPath : null;
    setCurrent(start);
    setInput(start ?? "");
    setInputError(null);
    setActionError(null);
    setNewName("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rootsKey = open && current === null ? ["fs-roots"] : null;
  const roots = useSWR(rootsKey, () => listFsRoots(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const dirKey = open && current !== null ? ["fs-dir", current] : null;
  const dir = useSWR(dirKey, () => listFsDir(current as string), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    keepPreviousData: false,
  });

  const crumbs: PathCrumb[] = useMemo(
    () => (current ? pathBreadcrumbs(current) : []),
    [current]
  );

  const entries = useMemo(() => {
    if (current === null) {
      return (roots.data?.roots ?? []).map((root) => ({
        name: root,
        path: root,
      }));
    }
    return dir.data?.entries ?? [];
  }, [current, roots.data, dir.data]);

  /** 上一级目标：后端给了就用后端的，否则从面包屑推（列目录失败时仍可返回）。 */
  const upTarget: string | null = useMemo(() => {
    if (current === null) return null;
    if (dir.data) return dir.data.parent;
    return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
  }, [current, dir.data, crumbs]);

  const goTo = useCallback((path: string) => {
    setCurrent(path);
    setInput(path);
    setInputError(null);
    setActionError(null);
    setNewName("");
  }, []);

  const goRoots = useCallback(() => {
    setCurrent(null);
    setInput("");
    setInputError(null);
    setActionError(null);
    setNewName("");
  }, []);

  const handleGo = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed === "") {
      goRoots();
      return;
    }
    if (!isAbsolutePath(trimmed)) {
      setInputError(zh.fs.requiredAbsolute);
      return;
    }
    goTo(trimmed);
  }, [input, goRoots, goTo]);

  const handleUp = useCallback(() => {
    if (current === null) return;
    if (upTarget) {
      goTo(upTarget);
    } else {
      goRoots();
    }
  }, [current, upTarget, goTo, goRoots]);

  const handleConfirm = useCallback(
    async (path: string | null, create: boolean) => {
      if (!path || !isAbsolutePath(path)) {
        setInputError(zh.fs.requiredAbsolute);
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        await onSubmit(path, create);
        onOpenChange(false);
      } catch (err) {
        setActionError(
          t(create ? zh.fs.createFailed : zh.fs.selectFailed, {
            error: String((err as Error).message ?? err),
          })
        );
      } finally {
        setBusy(false);
      }
    },
    [onSubmit, onOpenChange]
  );

  const handleCreate = useCallback(() => {
    const name = newName.trim();
    if (!current || name === "") return;
    void handleConfirm(joinPath(current, name), true);
  }, [current, newName, handleConfirm]);

  /** 在后端所在机器上弹系统「选择文件夹」对话框（本项目就跑在你自己电脑上） */
  const handleNativePick = useCallback(async () => {
    setNativeBusy(true);
    setActionError(null);
    try {
      const result = await pickNativeFolder();
      if (result.path) {
        await handleConfirm(result.path, false);
      } else if (!result.cancelled) {
        setActionError(t(zh.fs.nativeFailed, { error: result.error ?? "" }));
      }
    } catch (err) {
      setActionError(
        t(zh.fs.nativeFailed, { error: String((err as Error).message ?? err) })
      );
    } finally {
      setNativeBusy(false);
    }
  }, [handleConfirm]);

  const listingError = current === null ? roots.error : dir.error;
  const isLoading = current === null ? roots.isLoading : dir.isLoading;
  const listingErrorMessage = listingError
    ? t(current === null ? zh.fs.rootsFailed : zh.fs.listFailed, {
        error: String((listingError as Error).message ?? listingError),
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,640px)] flex-col gap-3 overflow-hidden sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{zh.fs.title}</DialogTitle>
          <DialogDescription>{zh.fs.description}</DialogDescription>
        </DialogHeader>

        {/* 首选：直接弹本机系统文件夹对话框（拿到真实绝对路径，无需逐层浏览） */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-[var(--color-surface)] px-3 py-2">
          <button
            type="button"
            onClick={() => void handleNativePick()}
            disabled={nativeBusy || busy}
            data-fs-native-pick
            className="flex shrink-0 items-center gap-1.5 rounded bg-[var(--color-primary)] px-2.5 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {nativeBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Folder size={13} />
            )}
            {zh.fs.nativePick}
          </button>
          <span className="min-w-0 flex-1 text-[11px] text-[var(--color-text-secondary)]">
            {zh.fs.nativeHint}
          </span>
        </div>

        {/* 当前目录的完整绝对路径（8.10）+ 过长时中间省略（8.11） */}
        <div className="min-w-0 rounded-md border border-border bg-[var(--color-surface)] px-3 py-2">
          <p className="text-[11px] text-[var(--color-text-tertiary)]">
            {zh.fs.pathLabel}
          </p>
          {current ? (
            <PathLabel
              path={current}
              max={64}
              tail={34}
              className="text-xs text-[var(--color-text-primary)]"
            />
          ) : (
            <p className="text-xs text-[var(--color-text-secondary)]">
              {zh.fs.roots}
            </p>
          )}
        </div>

        {/* 直接输入绝对路径 */}
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <input
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setInputError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleGo();
                }
              }}
              placeholder={zh.fs.pathPlaceholder}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={handleGo}
              className="flex shrink-0 items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface)]"
            >
              <MoveRight size={12} />
              {zh.fs.go}
            </button>
          </div>
          {inputError && (
            <p className="text-[11px] text-[var(--color-error)]">{inputError}</p>
          )}
        </div>

        {/* 面包屑 + 上一级 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={handleUp}
            disabled={current === null}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
          >
            <Undo2 size={12} />
            {zh.fs.up}
          </button>
          {current === null ? (
            <span className="flex min-w-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
              <HardDrive size={13} className="shrink-0" />
              <span className="truncate">{zh.fs.roots}</span>
            </span>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
              {crumbs.map((crumb, index) => (
                <React.Fragment key={crumb.path}>
                  {index > 0 && (
                    <span className="text-[var(--color-text-tertiary)]">/</span>
                  )}
                  <button
                    type="button"
                    onClick={() => goTo(crumb.path)}
                    title={crumb.path}
                    className={cn(
                      "max-w-[160px] truncate rounded px-1 py-0.5 hover:bg-[var(--color-surface)]",
                      index === crumbs.length - 1
                        ? "font-medium text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-secondary)]"
                    )}
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* 目录列表（只列目录） */}
        <div className="min-h-[160px] flex-1 overflow-auto rounded-md border border-border">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 text-xs text-[var(--color-text-secondary)]">
              <Loader2 size={13} className="animate-spin" />
              {zh.fs.loading}
            </div>
          )}
          {!isLoading && listingErrorMessage && (
            <div className="space-y-1.5 p-3 text-xs text-[var(--color-error)]">
              <p>{listingErrorMessage}</p>
              <p className="text-[var(--color-text-secondary)]">
                {zh.fs.accessHint}
              </p>
              <div className="flex gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={handleUp}
                  className="rounded border border-border px-2 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
                >
                  {zh.fs.up}
                </button>
                <button
                  type="button"
                  onClick={goRoots}
                  className="rounded border border-border px-2 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]"
                >
                  {zh.fs.backToRoots}
                </button>
              </div>
            </div>
          )}
          {!isLoading && !listingErrorMessage && entries.length === 0 && (
            <p className="p-3 text-xs text-[var(--color-text-tertiary)]">
              {zh.fs.empty}
            </p>
          )}
          {!isLoading &&
            !listingErrorMessage &&
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => goTo(entry.path)}
                title={entry.path}
                className="flex w-full min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-[var(--color-surface)]"
              >
                <Folder
                  size={14}
                  className="shrink-0 text-[var(--color-warning)]"
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))}
        </div>

        {/* 新建目录 */}
        <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
          <p className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
            <FolderPlus size={12} />
            {zh.fs.newDir}
          </p>
          <div className="flex items-center gap-1.5">
            <input
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setActionError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreate();
                }
              }}
              placeholder={zh.fs.newDirPlaceholder}
              disabled={current === null}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy || current === null || newName.trim() === ""}
              className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-primary)] px-2 py-1 text-xs text-white disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FolderPlus size={12} />
              )}
              {busy ? zh.fs.creating : zh.fs.create}
            </button>
          </div>
        </div>

        {actionError && (
          <p className="text-[11px] text-[var(--color-error)]">{actionError}</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => void dir.mutate()}
            disabled={current === null}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
          >
            <RefreshCw size={12} />
            {zh.workspace.refresh}
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded border border-border px-3 py-1 text-xs hover:bg-[var(--color-surface)]"
            >
              {zh.fs.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm(current, false)}
              disabled={busy || current === null}
              className="flex items-center gap-1 rounded bg-[var(--color-primary)] px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {zh.fs.useThis}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default DirectoryPicker;