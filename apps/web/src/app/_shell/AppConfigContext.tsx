"use client";

/**
 * 应用配置的上下文（部署地址 / 助手 ID）。
 *
 * 从 `page.tsx` 上提到根布局，是为了让配置与配置弹窗成为**跨页面常驻**的东西：
 * 顶部栏的设置入口在任何页面都能打开同一个弹窗，换页不会重建客户端。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryState } from "nuqs";
import { getConfig, saveConfig, type StandaloneConfig } from "@/lib/config";

interface AppConfigContextValue {
  /** 已保存的配置；`null` 表示还没读到（客户端首次渲染的一瞬）。 */
  config: StandaloneConfig | null;
  configDialogOpen: boolean;
  setConfigDialogOpen: (open: boolean) => void;
  openConfigDialog: () => void;
  handleSaveConfig: (next: StandaloneConfig) => void;
}

const AppConfigContext = createContext<AppConfigContextValue | undefined>(
  undefined
);

export function useAppConfig(): AppConfigContextValue {
  const context = useContext(AppConfigContext);
  if (!context) {
    throw new Error("useAppConfig must be used within AppConfigProvider");
  }
  return context;
}

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<StandaloneConfig | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [assistantId, setAssistantId] = useQueryState("assistantId");

  // 与改造前一致：挂载时读取本地配置，顺便把 assistantId 写进地址（可分享）。
  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
      if (!assistantId) setAssistantId(savedConfig.assistantId);
    } else {
      setConfigDialogOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (config && !assistantId) setAssistantId(config.assistantId);
  }, [config, assistantId, setAssistantId]);

  const handleSaveConfig = useCallback((next: StandaloneConfig) => {
    saveConfig(next);
    setConfig(next);
  }, []);

  const openConfigDialog = useCallback(() => setConfigDialogOpen(true), []);

  const value = useMemo(
    () => ({
      config,
      configDialogOpen,
      setConfigDialogOpen,
      openConfigDialog,
      handleSaveConfig,
    }),
    [config, configDialogOpen, openConfigDialog, handleSaveConfig]
  );

  return (
    <AppConfigContext.Provider value={value}>
      {children}
    </AppConfigContext.Provider>
  );
}