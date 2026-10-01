"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  FormEvent,
  Fragment,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Square,
  ArrowUp,
  CheckCircle,
  Clock,
  Circle,
  FileIcon,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { ChatTurn } from "@/app/components/ChatMessage";
import { ChatWelcome } from "@/app/components/ChatWelcome";
import { DirectoryPicker } from "@/app/components/workspace/DirectoryPicker";
import type {
  TodoItem,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Assistant } from "@langchain/langgraph-sdk";
import { groupMessagesIntoTurns } from "@/app/utils/turns";
import { useChatContext } from "@/providers/ChatProvider";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { cn } from "@/lib/utils";
import { useStickToBottom } from "use-stick-to-bottom";
import { FilesPopover } from "@/app/components/TasksFilesSidebar";
import zh, { t } from "@/i18n/zh";

interface ChatInterfaceProps {
  assistant: Assistant | null;
}

/** 对话宽度模式在 localStorage 的键（10.13）。 */
const CHAT_WIDTH_KEY = "open-assistant.chat-width";
/** 窄幅模式的限宽宽度（px，居中）；宽幅模式不设上限，铺满可用空间。 */
const NARROW_MAX_WIDTH = "1024px";

const getStatusIcon = (status: TodoItem["status"], className?: string) => {
  switch (status) {
    case "completed":
      return (
        <CheckCircle
          size={16}
          className={cn("text-[var(--color-success)]", className)}
        />
      );
    case "in_progress":
      return (
        <Clock
          size={16}
          className={cn("text-[var(--color-warning)]", className)}
        />
      );
    default:
      return (
        <Circle
          size={16}
          className={cn("text-[var(--color-text-tertiary)]", className)}
        />
      );
  }
};

export const ChatInterface = React.memo<ChatInterfaceProps>(({ assistant }) => {
  const [metaOpen, setMetaOpen] = useState<"tasks" | "files" | null>(null);
  const [wide, setWide] = useState(false);
  const tasksContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 宽窄模式持久化：仅切 className，不重建子树、不重新拉取消息（10.13）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    setWide(window.localStorage.getItem(CHAT_WIDTH_KEY) === "wide");
  }, []);

  const toggleWidth = useCallback(() => {
    setWide((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CHAT_WIDTH_KEY, next ? "wide" : "narrow");
      }
      return next;
    });
  }, []);

  const [input, setInput] = useState("");
  // 欢迎界面的「选择本机目录」直接复用工作区面板里的同一个选择器（同一套浏览/校验逻辑）。
  const [pickerOpen, setPickerOpen] = useState(false);
  const { scrollRef, contentRef } = useStickToBottom();

  const {
    stream,
    messages,
    todos,
    files,
    ui,
    setFiles,
    isLoading,
    isThreadLoading,
    interrupt,
    sendMessage,
    stopStream,
    resumeInterrupt,
  } = useChatContext();

  const { workspacePath, openWorkspace } = useWorkspaceContext();

  // 未选择工作区时禁止发送（对齐 specs/workspace「未指定工作区不得对话」）：
  // 前端禁用只是体验，真正的约束由后端在 run 入口与工具层双重强校验。
  const submitDisabled = isLoading || !assistant || !workspacePath;

  const handleSubmit = useCallback(
    (e?: FormEvent) => {
      if (e) {
        e.preventDefault();
      }
      const messageText = input.trim();
      if (!messageText || isLoading || submitDisabled) return;
      sendMessage(messageText);
      setInput("");
    },
    [input, isLoading, sendMessage, submitDisabled]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (submitDisabled) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, submitDisabled]
  );

  /*
    回合聚合：把「同一次提交产生的多条 AI 消息」（think→tool→think→tool→…→answer）
    归为一个回合，过程可折叠、结论常驻。关联键是 tool_call.id，
    具体实现与理由见 src/app/utils/turns.ts 与 openspec design.md Decisions #2。
  */
  const turns = useMemo(
    () => groupMessagesIntoTurns(messages, interrupt !== undefined),
    [messages, interrupt]
  );

  const groupedTodos = {
    in_progress: todos.filter((item) => item.status === "in_progress"),
    pending: todos.filter((item) => item.status === "pending"),
    completed: todos.filter((item) => item.status === "completed"),
  };

  const hasTasks = todos.length > 0;
  const hasFiles = Object.keys(files).length > 0;

  // Parse out any action requests or review configs from the interrupt
  const actionRequestsMap: Map<string, ActionRequest> | null = useMemo(() => {
    const actionRequests =
      interrupt?.value && (interrupt.value as any)["action_requests"];
    if (!actionRequests) return new Map<string, ActionRequest>();
    return new Map(actionRequests.map((ar: ActionRequest) => [ar.name, ar]));
  }, [interrupt]);

  const reviewConfigsMap: Map<string, ReviewConfig> | null = useMemo(() => {
    const reviewConfigs =
      interrupt?.value && (interrupt.value as any)["review_configs"];
    if (!reviewConfigs) return new Map<string, ReviewConfig>();
    return new Map(
      reviewConfigs.map((rc: ReviewConfig) => [rc.actionName, rc])
    );
  }, [interrupt]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        ref={scrollRef}
        data-chat-scroll
      >
        {/*
          滚动内边距：顶部留出与顶栏等量的呼吸空间（pt-6），底部留出输入区的
          高度余量（pb-10），保证最早/最晚的消息都不会被固定区域裁切。
        */}
        <div
          data-chat-content
          data-chat-width={wide ? "wide" : "narrow"}
          className={cn(
            "w-full px-6 pb-10 pt-6",
            wide
              ? "max-w-none"
              : "mx-auto"
          )}
          style={wide ? undefined : { maxWidth: NARROW_MAX_WIDTH }}
          ref={contentRef}
        >
          {isThreadLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-sm text-[var(--color-text-secondary)]">
                {zh.common.loading}
              </p>
            </div>
          ) : turns.length === 0 ? (
            <ChatWelcome
              workspacePath={workspacePath}
              disabled={submitDisabled}
              onSubmit={(text) => sendMessage(text)}
              onPickWorkspace={() => setPickerOpen(true)}
            />
          ) : (
            <div className="flex flex-col gap-6" data-chat-turns>
              {turns.map((turn, index) => {
                const isLastTurn = index === turns.length - 1;
                const streamThisTurn = isLastTurn && isLoading;
                return (
                  <ChatTurn
                    key={turn.id}
                    turn={turn}
                    isStreaming={streamThisTurn}
                    turnEnded={!streamThisTurn}
                    isLoading={isLoading}
                    stream={stream}
                    graphId={assistant?.graph_id}
                    actionRequestsMap={
                      isLastTurn ? actionRequestsMap : undefined
                    }
                    reviewConfigsMap={isLastTurn ? reviewConfigsMap : undefined}
                    onResumeInterrupt={resumeInterrupt}
                    ui={ui}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 bg-background">
        <div
          data-chat-composer
          className={cn(
            "mb-6 flex flex-shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background",
            "w-[calc(100%-32px)]",
            wide ? "mx-auto max-w-none" : "mx-auto",
            "transition-colors duration-200 ease-in-out"
          )}
          style={wide ? undefined : { maxWidth: NARROW_MAX_WIDTH }}
        >
          {(hasTasks || hasFiles) && (
            <div className="flex max-h-72 flex-col overflow-y-auto border-b border-border bg-sidebar empty:hidden">
              {!metaOpen && (
                <div className="grid grid-cols-[1fr_auto_auto] items-center">
                  {hasTasks &&
                    (() => {
                      const activeTask = todos.find(
                        (item) => item.status === "in_progress"
                      );
                      const totalTasks = todos.length;
                      const remainingTasks =
                        totalTasks - groupedTodos.pending.length;
                      const isCompleted = totalTasks === remainingTasks;
                      return (
                        <button
                          type="button"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "tasks" ? null : "tasks"
                            )
                          }
                          className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr] items-center gap-3 px-[18px] py-3 text-left"
                          aria-expanded={metaOpen === "tasks"}
                        >
                          {isCompleted ? (
                            <>
                              <CheckCircle
                                size={16}
                                className="text-[var(--color-success)]"
                              />
                              <span className="ml-[1px] min-w-0 truncate text-sm">
                                {zh.tasks.allCompleted}
                              </span>
                            </>
                          ) : activeTask != null ? (
                            <>
                              <div>{getStatusIcon(activeTask.status)}</div>
                              <span className="ml-[1px] min-w-0 truncate text-sm">
                                {t(zh.tasks.progress, {
                                  done: remainingTasks,
                                  total: totalTasks,
                                })}
                              </span>
                              <span className="min-w-0 truncate text-sm text-muted-foreground">
                                {activeTask.content}
                              </span>
                            </>
                          ) : (
                            <>
                              <Circle
                                size={16}
                                className="text-[var(--color-text-tertiary)]"
                              />
                              <span className="ml-[1px] min-w-0 truncate text-sm">
                                {t(zh.tasks.progress, {
                                  done: remainingTasks,
                                  total: totalTasks,
                                })}
                              </span>
                            </>
                          )}
                        </button>
                      );
                    })()}

                  {hasFiles && (
                    <button
                      type="button"
                      onClick={() =>
                        setMetaOpen((prev) =>
                          prev === "files" ? null : "files"
                        )
                      }
                      className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-[18px] py-3 text-left text-sm"
                      aria-expanded={metaOpen === "files"}
                    >
                      <FileIcon size={16} />
                      {zh.files.panelTitle}
                      <span className="h-4 min-w-4 rounded-full bg-[#2F6868] px-0.5 text-center text-[10px] leading-[16px] text-white">
                        {Object.keys(files).length}
                      </span>
                    </button>
                  )}
                </div>
              )}

              {metaOpen && (
                <>
                  <div className="sticky top-0 flex items-stretch bg-sidebar text-sm">
                    {hasTasks && (
                      <button
                        type="button"
                        className="py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
                        onClick={() =>
                          setMetaOpen((prev) =>
                            prev === "tasks" ? null : "tasks"
                          )
                        }
                        aria-expanded={metaOpen === "tasks"}
                      >
                        {zh.tasks.panelTitle}
                      </button>
                    )}
                    {hasFiles && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
                        onClick={() =>
                          setMetaOpen((prev) =>
                            prev === "files" ? null : "files"
                          )
                        }
                        aria-expanded={metaOpen === "files"}
                      >
                        {zh.files.panelTitle}
                        <span className="h-4 min-w-4 rounded-full bg-[#2F6868] px-0.5 text-center text-[10px] leading-[16px] text-white">
                          {Object.keys(files).length}
                        </span>
                      </button>
                    )}
                    <button
                      aria-label={zh.common.close}
                      className="flex-1"
                      onClick={() => setMetaOpen(null)}
                    />
                  </div>
                  <div
                    ref={tasksContainerRef}
                    className="px-[18px]"
                  >
                    {metaOpen === "tasks" &&
                      Object.entries(groupedTodos)
                        .filter(([, items]) => items.length > 0)
                        .map(([status, items]) => (
                          <div
                            key={status}
                            className="mb-4"
                          >
                            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                              {
                                {
                                  pending: zh.tasks.pending,
                                  in_progress: zh.tasks.inProgress,
                                  completed: zh.tasks.completed,
                                }[status]
                              }
                            </h3>
                            <div className="grid grid-cols-[auto_1fr] gap-3 rounded-sm p-1 pl-0 text-sm">
                              {items.map((todo, index) => (
                                <Fragment key={`${status}_${todo.id}_${index}`}>
                                  {getStatusIcon(todo.status, "mt-0.5")}
                                  <span className="break-words text-inherit">
                                    {todo.content}
                                  </span>
                                </Fragment>
                              ))}
                            </div>
                          </div>
                        ))}

                    {metaOpen === "files" && (
                      <div className="mb-6">
                        <FilesPopover
                          files={files}
                          setFiles={setFiles}
                          editDisabled={
                            isLoading === true || interrupt !== undefined
                          }
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <form
            onSubmit={handleSubmit}
            className="flex flex-col"
          >
            {!workspacePath && (
              <p className="border-b border-border px-4 py-2 text-xs text-[var(--color-warning)]">
                {zh.workspace.requiredHint}
              </p>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isLoading ? zh.chat.placeholderRunning : zh.chat.placeholder
              }
              className="font-inherit field-sizing-content flex-1 resize-none border-0 bg-transparent px-[18px] pb-[13px] pt-[14px] text-sm leading-7 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
              rows={1}
            />
            <div className="flex justify-between gap-2 p-3">
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={toggleWidth}
                  aria-pressed={wide}
                  aria-label={wide ? zh.chatWidth.toNarrow : zh.chatWidth.toWide}
                  title={wide ? zh.chatWidth.toNarrow : zh.chatWidth.toWide}
                  data-chat-width-toggle
                >
                  {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  <span>
                    {wide ? zh.chatWidth.wide : zh.chatWidth.narrow}
                  </span>
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type={isLoading ? "button" : "submit"}
                  variant={isLoading ? "destructive" : "default"}
                  onClick={isLoading ? stopStream : handleSubmit}
                  disabled={!isLoading && (submitDisabled || !input.trim())}
                >
                  {isLoading ? (
                    <>
                      <Square size={14} />
                      <span>{zh.chat.stop}</span>
                    </>
                  ) : (
                    <>
                      <ArrowUp size={18} />
                      <span>{zh.chat.send}</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>

      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={workspacePath}
        onSubmit={async (path, create) => {
          await openWorkspace(path, create);
        }}
      />
    </div>
  );
});

ChatInterface.displayName = "ChatInterface";