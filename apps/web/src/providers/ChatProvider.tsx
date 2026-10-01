"use client";

import { ReactNode, createContext, useContext, useEffect, useRef } from "react";
import { Assistant } from "@langchain/langgraph-sdk";
import { type StateType, useChat } from "@/app/hooks/useChat";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import { WorkspaceContext } from "@/providers/WorkspaceProvider";

interface ChatProviderProps {
  children: ReactNode;
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  /** 当前工作区的绝对路径（传给 run 的 `config.configurable.workspace`）。 */
  workspace?: string | null;
  thread?: UseStreamThread<StateType>;
}

export function ChatProvider({
  children,
  activeAssistant,
  onHistoryRevalidate,
  workspace,
  thread,
}: ChatProviderProps) {
  const chat = useChat({ activeAssistant, onHistoryRevalidate, workspace, thread });
  const workspaceCtx = useContext(WorkspaceContext);
  const notifyWorkspaceChanged = workspaceCtx?.notifyWorkspaceChanged;
  const wasLoading = useRef(false);

  /*
    改动可见性（对齐 specs/file-workspace-ui「文件内容随改动可见」）：
    agent 在 run 过程中会写入文件、增删 TODO，界面需要在无需手动刷新的前提下反映。
    - 流式进行中：周期性通知刷新（文件树 / 已打开预览 / TODO 视图重新拉取）；
    - 流式结束时：再通知一次，确保最后一次写入被反映。
  */
  useEffect(() => {
    if (!notifyWorkspaceChanged) return;
    if (chat.isLoading) {
      wasLoading.current = true;
      const timer = setInterval(() => notifyWorkspaceChanged(), 1500);
      return () => clearInterval(timer);
    }
    if (wasLoading.current) {
      wasLoading.current = false;
      notifyWorkspaceChanged();
    }
  }, [chat.isLoading, notifyWorkspaceChanged]);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export type ChatContextType = ReturnType<typeof useChat>;

export const ChatContext = createContext<ChatContextType | undefined>(
  undefined
);

export function useChatContext() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}