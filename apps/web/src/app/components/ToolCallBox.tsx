"use client";

import React, { useMemo } from "react";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import { ToolCard } from "@/app/components/ToolCards";
import { adaptToolCall } from "@/app/components/ToolCards/types";
import type {
  ActionRequest,
  ReviewConfig,
  ToolCall,
} from "@/app/types/types";

interface ToolCallBoxProps {
  toolCall: ToolCall;
  uiComponent?: any;
  stream?: any;
  graphId?: string;
  actionRequest?: ActionRequest;
  reviewConfig?: ReviewConfig;
  onResume?: (value: any) => void;
  isLoading?: boolean;
  /** 该调用所在回合是否已经结束（用于给悬挂调用收尾，避免永远转圈）。 */
  turnEnded?: boolean;
}

/**
 * 单次工具调用的渲染入口。
 *
 * 它自己不再负责「好看」——那只做三件事：
 * 1. 把 `ToolCall` 适配成卡片契约（含三态推导、参数键归一化）；
 * 2. 交给注册表选中的专属卡片渲染；
 * 3. 保留基座原有的两个扩展点：GenUI 外挂组件与人工审批中断。
 */
export const ToolCallBox = React.memo<ToolCallBoxProps>(
  ({
    toolCall,
    uiComponent,
    stream,
    graphId,
    actionRequest,
    reviewConfig,
    onResume,
    isLoading,
    turnEnded = false,
  }) => {
    const awaitingApproval = Boolean(actionRequest && onResume);
    const isStreaming = Boolean(isLoading) && !turnEnded;

    const content = useMemo(
      () =>
        adaptToolCall(toolCall, {
          isStreaming,
          turnEnded,
          awaitingApproval,
        }),
      [toolCall, isStreaming, turnEnded, awaitingApproval]
    );

    return (
      <div className="w-full min-w-0">
        <ToolCard
          content={content}
          isStreaming={isStreaming}
        />

        {uiComponent && stream && graphId && (
          <div className="mt-2 pl-4">
            <LoadExternalComponent
              key={uiComponent.id}
              stream={stream}
              message={uiComponent}
              namespace={graphId}
              meta={{
                status: content.status,
                args: content.params,
                result: content.result ?? "",
              }}
            />
          </div>
        )}

        {awaitingApproval && actionRequest && onResume && (
          <div className="mt-2 pl-4">
            <ToolApprovalInterrupt
              actionRequest={actionRequest}
              reviewConfig={reviewConfig}
              onResume={onResume}
              isLoading={isLoading}
            />
          </div>
        )}
      </div>
    );
  }
);

ToolCallBox.displayName = "ToolCallBox";