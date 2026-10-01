"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQueryState } from "nuqs";
import {
  WorkspaceApiError,
  openWorkspace as openWorkspaceApi,
} from "@/lib/workspaceApi";
import { basename, isAbsolutePath } from "@/app/utils/path";
import zh, { t } from "@/i18n/zh";

/**
 * 工作区 = 用户在本机文件系统中选中的**绝对路径**（design.md Decision #3）。
 *
 * - URL 查询参数 `workspace`（可分享）+ localStorage（可记忆）双写；
 * - 「最近使用」列表只存本地（后端不再有工作区清单，工作区由用户自己选）；
 * - 旧值（服务端自建的 id，如 `default`）不是绝对路径：无法在前端可靠映射到磁盘位置，
 *   因此**提示重选**（不静默回退到别的目录），见 `legacyValue`。
 */
const LS_KEY = "open-assistant.workspace";
const LS_RECENT_KEY = "open-assistant.workspace-recent";
/** 旧 id 值：重选中之前临时保留，供界面提示。 */
const LS_LEGACY_KEY = "open-assistant.workspace-legacy";
const RECENT_LIMIT = 8;

function readRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function writeRecent(list: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用时忽略（不阻断选择） */
  }
}

interface WorkspaceContextValue {
  /** 当前工作区的绝对路径；null 表示尚未选择（此时必须禁止对话）。 */
  workspacePath: string | null;
  setWorkspacePath: (path: string | null) => void;
  /** 最近使用过的绝对路径（最新的在前）。 */
  recentWorkspaces: string[];
  /** 检测到的旧 id 工作区（如 `default`），需要用户重选；已重选或忽略后为 null。 */
  legacyValue: string | null;
  dismissLegacy: () => void;
  /**
   * 归一化 / 创建目录并设为当前工作区，返回归一化后的绝对路径。
   * 失败时抛 `WorkspaceApiError`（调用方展示可读错误）。
   */
  openWorkspace: (path: string, create?: boolean) => Promise<string>;
  isOpening: boolean;
  /**
   * 文件/待办刷新计数。agent 改动、手工刷新、界面内修改后自增，
   * 依赖它的文件树与预览会重新拉取，从而「无需手动刷新页面即反映改动」。
   */
  revision: number;
  notifyWorkspaceChanged: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(
  undefined
);

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (ctx === undefined) {
    throw new Error("useWorkspaceContext must be used within a WorkspaceProvider");
  }
  return ctx;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspacePath, setWorkspaceParam] = useQueryState("workspace");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [legacyValue, setLegacyValue] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [revision, setRevision] = useState(0);

  // 首次挂载：URL 优先，其次 localStorage；旧 id 值转为「提示重选」。
  useEffect(() => {
    if (typeof window === "undefined") return;
    setRecentWorkspaces(readRecent());

    const fromUrl = workspacePath?.trim() ?? "";
    const stored = window.localStorage.getItem(LS_KEY)?.trim() ?? "";
    const candidate = fromUrl || stored;

    if (!candidate) return;

    if (isAbsolutePath(candidate)) {
      if (!fromUrl) void setWorkspaceParam(candidate);
      return;
    }

    // 旧 id：不静默映射（前端无法知道后端工作区根的真实位置），提示用户重选。
    window.localStorage.setItem(LS_LEGACY_KEY, candidate);
    window.localStorage.removeItem(LS_KEY);
    setLegacyValue(candidate);
    if (fromUrl) void setWorkspaceParam(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选择变化 → 写回 localStorage（供下次进入记忆）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (workspacePath) {
      window.localStorage.setItem(LS_KEY, workspacePath);
    }
  }, [workspacePath]);

  const setWorkspacePath = useCallback(
    (path: string | null) => {
      if (typeof window !== "undefined") {
        if (path) {
          window.localStorage.setItem(LS_KEY, path);
        } else {
          window.localStorage.removeItem(LS_KEY);
        }
      }
      void setWorkspaceParam(path);
    },
    [setWorkspaceParam]
  );

  const rememberRecent = useCallback((path: string) => {
    setRecentWorkspaces((prev) => {
      const next = [path, ...prev.filter((item) => item !== path)].slice(
        0,
        RECENT_LIMIT
      );
      writeRecent(next);
      return next;
    });
  }, []);

  const openWorkspace = useCallback(
    async (path: string, create = false) => {
      const trimmed = path.trim();
      if (!isAbsolutePath(trimmed)) {
        throw new WorkspaceApiError("WORKSPACE_INVALID_PATH", zh.fs.requiredAbsolute);
      }
      setIsOpening(true);
      try {
        const result = await openWorkspaceApi(trimmed, create);
        const normalized = result.path || trimmed;
        rememberRecent(normalized);
        setWorkspacePath(normalized);
        setLegacyValue(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LS_LEGACY_KEY);
        }
        return normalized;
      } finally {
        setIsOpening(false);
      }
    },
    [rememberRecent, setWorkspacePath]
  );

  const dismissLegacy = useCallback(() => {
    setLegacyValue(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LS_LEGACY_KEY);
    }
  }, []);

  const notifyWorkspaceChanged = useCallback(() => {
    setRevision((prev) => prev + 1);
  }, []);

  const value: WorkspaceContextValue = useMemo(
    () => ({
      workspacePath,
      setWorkspacePath,
      recentWorkspaces,
      legacyValue,
      dismissLegacy,
      openWorkspace,
      isOpening,
      revision,
      notifyWorkspaceChanged,
    }),
    [
      workspacePath,
      setWorkspacePath,
      recentWorkspaces,
      legacyValue,
      dismissLegacy,
      openWorkspace,
      isOpening,
      revision,
      notifyWorkspaceChanged,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

/** 当前工作区的显示名（目录名）；没有工作区时返回 null。 */
export function workspaceDisplayName(path: string | null): string | null {
  if (!path) return null;
  return basename(path) || path;
}

/** 便于测试与调用方拼接错误信息。 */
export function workspaceErrorText(path: string, err: unknown): string {
  const message =
    err instanceof WorkspaceApiError
      ? err.message
      : String((err as Error)?.message ?? err);
  return t(zh.workspace.openFailed, { error: message });
}