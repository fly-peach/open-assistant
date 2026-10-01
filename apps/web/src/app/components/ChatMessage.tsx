"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Message } from "@langchain/langgraph-sdk";
import { SubAgentIndicator } from "@/app/components/SubAgentIndicator";
import { ToolCallBox } from "@/app/components/ToolCallBox";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { ThinkingBlock } from "@/app/components/ThinkingBlock";
import {
  countSteps,
  type ProcessStep,
  type Turn,
  type TurnStep,
} from "@/app/utils/turns";
import type {
  ActionRequest,
  ReviewConfig,
  SubAgent,
  ToolCall,
} from "@/app/types/types";
import {
  extractStringFromMessageContent,
  extractSubAgentContent,
} from "@/app/utils/utils";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 用户消息
// ---------------------------------------------------------------------------

export const UserMessageBubble = React.memo<{ message: Message }>(
  ({ message }) => {
    const content = extractStringFromMessageContent(message);
    if (!content.trim()) return null;
    return (
      <div className="flex w-full max-w-full flex-row-reverse overflow-x-hidden">
        <div className="min-w-0 max-w-[70%]">
          <div
            className="mt-4 overflow-hidden break-words rounded-xl rounded-br-none border border-border px-3 py-2 text-sm font-normal leading-[150%] text-foreground"
            style={{ backgroundColor: "var(--color-user-message-bg)" }}
          >
            <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {content}
            </p>
          </div>
        </div>
      </div>
    );
  }
);
UserMessageBubble.displayName = "UserMessageBubble";

// ---------------------------------------------------------------------------
// 子代理面板（保留基座原有功能）
// ---------------------------------------------------------------------------

function toSubAgents(toolCalls: ToolCall[]): SubAgent[] {
  return toolCalls
    .filter(
      (toolCall: ToolCall) =>
        toolCall.name === "task" &&
        toolCall.args["subagent_type"] &&
        toolCall.args["subagent_type"] !== "" &&
        toolCall.args["subagent_type"] !== null
    )
    .map((toolCall: ToolCall) => {
      const subagentType = (toolCall.args as Record<string, unknown>)[
        "subagent_type"
      ] as string;
      return {
        id: toolCall.id,
        name: toolCall.name,
        subAgentName: subagentType,
        input: toolCall.args,
        output: toolCall.result ? { result: toolCall.result } : undefined,
        status: toolCall.status,
      } as SubAgent;
    });
}

const SubAgentPanels = React.memo<{ toolCalls: ToolCall[] }>(({ toolCalls }) => {
  const subAgents = useMemo(() => toSubAgents(toolCalls), [toolCalls]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = useCallback(
    (id: string) => expanded[id] ?? true,
    [expanded]
  );
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? false : !prev[id],
    }));
  }, []);

  if (subAgents.length === 0) return null;

  return (
    <div className="flex w-fit max-w-full flex-col gap-4">
      {subAgents.map((subAgent) => (
        <div
          key={subAgent.id}
          className="flex w-full flex-col gap-2"
        >
          <div className="flex items-end gap-2">
            <div className="w-[calc(100%-100px)]">
              <SubAgentIndicator
                subAgent={subAgent}
                onClick={() => toggle(subAgent.id)}
                isExpanded={isExpanded(subAgent.id)}
              />
            </div>
          </div>
          {isExpanded(subAgent.id) && (
            <div className="w-full max-w-full">
              <div className="rounded-md border border-[var(--color-border-light)] bg-[var(--color-surface)] p-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {zh.tool.sectionInput}
                </h4>
                <div className="mb-4">
                  <MarkdownContent
                    content={extractSubAgentContent(subAgent.input)}
                  />
                </div>
                {subAgent.output && (
                  <>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                      {zh.tool.sectionOutput}
                    </h4>
                    <MarkdownContent
                      content={extractSubAgentContent(subAgent.output)}
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
SubAgentPanels.displayName = "SubAgentPanels";

// ---------------------------------------------------------------------------
// 单条 AI 步骤（思考 + 工具调用）
// ---------------------------------------------------------------------------

interface StepSharedProps {
  isLoading?: boolean;
  turnEnded?: boolean;
  stream?: any;
  graphId?: string;
  actionRequestsMap?: Map<string, ActionRequest>;
  reviewConfigsMap?: Map<string, ReviewConfig>;
  onResumeInterrupt?: (value: any) => void;
  ui?: any[];
}

const AssistantStep = React.memo<
  StepSharedProps & { step: TurnStep; isStreaming?: boolean }
>(
  ({
    step,
    isStreaming,
    isLoading,
    turnEnded,
    stream,
    graphId,
    actionRequestsMap,
    reviewConfigsMap,
    onResumeInterrupt,
    ui,
  }) => {
    const { message, reasoning, toolCalls } = step;
    const hasReasoning = reasoning.trim() !== "";
    const renderable = toolCalls.filter((call) => call.name !== "task");

    return (
      <div className="flex w-full min-w-0 flex-col">
        {hasReasoning && (
          <ThinkingBlock
            content={reasoning}
            streaming={isStreaming}
            compact
          />
        )}
        {renderable.length > 0 && (
          <div className={cn("flex w-full flex-col", hasReasoning && "mt-2")}>
            {renderable.map((toolCall) => {
              const uiComponent = ui?.find(
                (u) => u.metadata?.tool_call_id === toolCall.id
              );
              return (
                <ToolCallBox
                  key={toolCall.id}
                  toolCall={toolCall}
                  uiComponent={uiComponent}
                  stream={stream}
                  graphId={graphId}
                  actionRequest={actionRequestsMap?.get(toolCall.name)}
                  reviewConfig={reviewConfigsMap?.get(toolCall.name)}
                  onResume={onResumeInterrupt}
                  isLoading={isLoading}
                  turnEnded={turnEnded}
                />
              );
            })}
          </div>
        )}
        {toolCalls.some((call) => call.name === "task") && (
          <div className={hasReasoning || renderable.length > 0 ? "mt-2" : ""}>
            <SubAgentPanels toolCalls={toolCalls} />
          </div>
        )}
        {/* 该步骤的正文（若有）也留在过程里：过程与结论分离由 ChatTurn 保证 */}
        {message.type === "ai" &&
          extractStringFromMessageContent(message).trim() !== "" && (
            <div className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
              <MarkdownContent
                content={extractStringFromMessageContent(message)}
              />
            </div>
          )}
      </div>
    );
  }
);
AssistantStep.displayName = "AssistantStep";

// ---------------------------------------------------------------------------
// 回合容器：过程可折叠 + 结论常驻
// ---------------------------------------------------------------------------

export interface ChatTurnProps extends StepSharedProps {
  turn: Turn;
  /** 该回合是否仍在流式生成。 */
  isStreaming?: boolean;
}

export const ChatTurn = React.memo<ChatTurnProps>(
  ({ turn, isStreaming = false, ...shared }) => {
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const open = userToggled ?? isStreaming;
    const [bodyMounted, setBodyMounted] = useState(open);

    // 程序化切换 open 也会触发 toggle 事件，不能把它当成用户意图，
    // 否则「流式结束后自动收起」永远不生效（userToggled 会被误置为 true）。
    const handleToggle = useCallback(
      (event: React.SyntheticEvent<HTMLDetailsElement>) => {
        const next = event.currentTarget.open;
        if (next === (userToggled ?? isStreaming)) return;
        setUserToggled(next);
        if (next) setBodyMounted(true);
      },
      [userToggled, isStreaming]
    );

    // 展开时惰性挂载过程内容（流式自动展开也要挂上）。
    useEffect(() => {
      if (open) setBodyMounted(true);
    }, [open]);

    const stepCount = countSteps(turn);
    const summaryLabel = turn.hasFailedTool
      ? t(zh.turn.processFailed, { count: stepCount })
      : isStreaming
      ? zh.turn.processRunning
      : t(zh.turn.processDone, { count: stepCount });

    const conclusion = turn.conclusion
      ? extractStringFromMessageContent(turn.conclusion)
      : "";

    return (
      <div className="flex w-full max-w-full flex-col">
        {turn.user && <UserMessageBubble message={turn.user} />}

        {stepCount > 0 && (
          <details
            className="mt-3 w-full min-w-0"
            open={open}
            onToggle={handleToggle}
          >
            <summary
              className={cn(
                "flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium [&::-webkit-details-marker]:hidden",
                // 失败不能被折叠隐藏：回合级摘要行直接标红报出「含失败」，
                // 用户无需展开就能知道这次回答里有失败的工具调用。
                turn.hasFailedTool
                  ? "text-destructive"
                  : isStreaming
                  ? "text-[var(--color-text-secondary)]"
                  : "text-[var(--color-text-tertiary)]",
                "transition-colors hover:text-[var(--color-text-secondary)]"
              )}
              aria-label={zh.turn.processToggle}
            >
              <span className="text-xxs tracking-wide">{summaryLabel}</span>
              <span className="text-[var(--color-text-tertiary)]">
                {open ? zh.turn.collapse : zh.turn.expand}
              </span>
            </summary>

            {bodyMounted && (
              <div className="mt-2 flex w-full min-w-0 flex-col gap-3 border-l-2 border-[var(--color-border-light)] pl-3">
                {turn.process.map((step: ProcessStep, index) => {
                  if (step.kind === "assistant") {
                    return (
                      <AssistantStep
                        key={step.message.id ?? `step-${index}`}
                        step={step}
                        isStreaming={isStreaming}
                        {...shared}
                      />
                    );
                  }
                  return (
                    <ToolCallBox
                      key={step.toolCall.id}
                      toolCall={step.toolCall}
                      isLoading={shared.isLoading}
                      turnEnded={shared.turnEnded}
                    />
                  );
                })}
              </div>
            )}
          </details>
        )}

        {conclusion.trim() !== "" && (
          <div className="mt-3 w-full min-w-0 break-words text-sm font-normal leading-[150%] text-[var(--color-text-primary)]">
            {isStreaming ? (
              <div>
                <MarkdownContent content={conclusion} />
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-[var(--color-text-tertiary)] align-text-bottom" />
              </div>
            ) : (
              <MarkdownContent content={conclusion} />
            )}
            {turn.conclusionToolCalls.length > 0 && (
              <div className="mt-2 flex w-full min-w-0 flex-col">
                {turn.conclusionToolCalls.map((toolCall) => (
                  <ToolCallBox
                    key={toolCall.id}
                    toolCall={toolCall}
                    isLoading={shared.isLoading}
                    turnEnded={shared.turnEnded}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);
ChatTurn.displayName = "ChatTurn";