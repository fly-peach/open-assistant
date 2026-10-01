"use client";

/**
 * 对话页的三栏布局（会话列表 | 对话 | 工作区）。
 *
 * 从改造前的 `page.tsx` 原样搬过来，只把顶部栏让给外壳：
 * 页面自己的操作（会话列表开关、新建会话、工作区开关）放在内容区的页面工具条里。
 * 工作区栏仍然渲染现有的 `<WorkspaceSidebar onClose={...} />`（路径与 props 不变），
 * 方便后续把它升级成可停靠面板。
 */
import React, {
  useCallback,
  useEffect,
  useState,
} from "react";
import { useQueryState } from "nuqs";
import type { Assistant } from "@langchain/langgraph-sdk";
import { FolderTree, MessagesSquare, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ThreadList } from "@/app/components/ThreadList";
import { ChatProvider } from "@/providers/ChatProvider";
import { ChatInterface } from "@/app/components/ChatInterface";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { WorkspaceSidebar } from "@/app/components/workspace/WorkspaceSidebar";
import { ThreadIdBadge } from "@/app/components/threads/ThreadIdBadge";
import { PathLabel } from "@/app/components/workspace/PathLabel";
import { DockablePanel } from "@/app/components/panel/DockablePanel";
import { FirstRunOnboarding } from "@/app/components/onboarding/FirstRunOnboarding";
import zh from "@/i18n/zh";

/** 工作区侧边栏展开状态在 localStorage 的键。 */
const WS_PANEL_KEY = "open-assistant.workspace-panel";
/** 首次运行引导是否已完成的键（完成过就不再弹）。 */
const ONBOARD_KEY = "open-assistant.onboarded";
/** 工作区面板停靠时的固定宽度（px）。
 * 面板现在是两栏文件浏览器（左＝文件列表 248，右＝文件内容），太窄会挤坏右栏。
 * 720 让两栏都能舒展（列表 + 预览的代码/表格）。 */
const WORKSPACE_PANEL_WIDTH = 720;

interface ChatWorkspaceProps {
  assistant: Assistant | null;
}

export function ChatWorkspace({ assistant }: ChatWorkspaceProps) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const [sidebar, setSidebar] = useQueryState("sidebar");
  const { workspacePath } = useWorkspaceContext();

  const [mutateThreads, setMutateThreads] = useState<(() => void) | null>(null);
  const [interruptCount, setInterruptCount] = useState(0);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // 恢复上次的展开/收起状态（面板常驻，收起只让出宽度、内容不卸载）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    setWorkspaceOpen(window.localStorage.getItem(WS_PANEL_KEY) === "1");
    setShowOnboarding(window.localStorage.getItem(ONBOARD_KEY) !== "1");
  }, []);

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    if (typeof window !== "undefined") window.localStorage.setItem(ONBOARD_KEY, "1");
  }, []);

  const handleWorkspaceOpenChange = useCallback((next: boolean) => {
    setWorkspaceOpen(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WS_PANEL_KEY, next ? "1" : "0");
    }
  }, []);

  const toggleWorkspace = useCallback(() => {
    handleWorkspaceOpenChange(!workspaceOpen);
  }, [workspaceOpen, handleWorkspaceOpenChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {!sidebar && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebar("1")}
            data-chat-toggle-threads
            className="rounded-md border border-border bg-card text-foreground hover:bg-accent"
          >
            <MessagesSquare className="mr-2 h-4 w-4" />
            {zh.app.threads}
            {interruptCount > 0 && (
              <span className="ml-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
                {interruptCount}
              </span>
            )}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {threadId && <ThreadIdBadge threadId={threadId} />}
          <Button
            variant="outline"
            size="sm"
            onClick={toggleWorkspace}
            aria-expanded={workspaceOpen}
            data-chat-toggle-workspace
            className="border-border bg-card text-foreground hover:bg-accent"
          >
            <FolderTree className="mr-2 h-4 w-4 shrink-0" />
            <span className="shrink-0">{zh.workspace.panelTitle}</span>
            {workspacePath && (
              <PathLabel
                path={workspacePath}
                max={18}
                tail={11}
                className="ml-2 max-w-[140px] text-xs text-muted-foreground"
              />
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setThreadId(null)}
            disabled={!threadId}
            data-chat-new-thread
            className="border-[#2F6868] bg-[#2F6868] text-white hover:bg-[#2F6868]/80"
          >
            <SquarePen className="mr-2 h-4 w-4" />
            {zh.app.newThread}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden" data-chat-columns>
        <div className="relative min-h-0 min-w-0 flex-1">
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="standalone-chat"
          >
            {sidebar && (
              <>
                <ResizablePanel
                  id="thread-history"
                  order={1}
                  defaultSize={25}
                  minSize={20}
                  className="relative min-w-[380px]"
                >
                  <ThreadList
                    onThreadSelect={async (id) => {
                      await setThreadId(id);
                    }}
                    onMutateReady={(fn) => setMutateThreads(() => fn)}
                    onClose={() => setSidebar(null)}
                    onInterruptCountChange={setInterruptCount}
                  />
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}

            <ResizablePanel
              id="chat"
              className="relative flex flex-col"
              order={2}
            >
              <ChatProvider
                activeAssistant={assistant}
                workspace={workspacePath}
                onHistoryRevalidate={() => mutateThreads?.()}
              >
                <ChatInterface assistant={assistant} />
              </ChatProvider>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* 可停靠工作区面板：默认停靠，可拖出浮动，收起后让出宽度（10.12）。 */}
        <DockablePanel
          id="workspace"
          open={workspaceOpen}
          onOpenChange={handleWorkspaceOpenChange}
          width={WORKSPACE_PANEL_WIDTH}
          label={zh.workspace.panelTitle}
        >
          <WorkspaceSidebar onClose={toggleWorkspace} />
        </DockablePanel>
      </div>

      {showOnboarding && <FirstRunOnboarding onDismiss={dismissOnboarding} />}
    </div>
  );
}