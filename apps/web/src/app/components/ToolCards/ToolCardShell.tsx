"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { DefaultBlock } from "@/app/components/ToolCards/DefaultBlock";
import {
  extractResultText,
  oneLine,
  stringifyResult,
  type CardProps,
} from "@/app/components/ToolCards/types";
import zh from "@/i18n/zh";
import { cn } from "@/lib/utils";

export interface ToolCardShellProps {
  content: CardProps["content"];
  isStreaming?: boolean;
  /** 摘要行左侧图标（lucide）。 */
  icon: React.ReactNode;
  /** 摘要行主文案，如「修改 /todo.md」。 */
  title: string;
  /** 摘要行右侧灰字。 */
  inlineResult?: string | null;
  /** 徽标（行数 / diff 计数等）。 */
  badges?: React.ReactNode;
  /** 紧跟标题的紧凑动作（如「预览」）。 */
  summaryAction?: React.ReactNode;
  /** 展开后的业务内容。错误态不会渲染它。 */
  children?: React.ReactNode;
  /** 默认展开（媒体类卡片用）。 */
  defaultExpanded?: boolean;
}

/**
 * 所有工具卡片共用的外壳。
 *
 * 照搬 QwenPaw 架构（`shared/ToolCardShell.tsx`，见 .scratch/research/qwenpaw-toolcards.md）：
 * - 用原生 `<details>/<summary>` 承载折叠，免费拿到键盘可达性与语义；
 * - 三态视觉（进行中 / 成功 / 失败）；
 * - **错误态统一由外壳呈现（输入参数 + 错误原因），且不渲染 children** ——
 *   这样每张卡片开头只需一句 `if (status === "error") return <ToolCardShell .../>`，
 *   卡片作者不需要写任何错误 UI；
 * - 懒挂载展开内容：折叠时完全不渲染结果块（大输出/媒体预览的性能关键）。
 *
 * 与 QwenPaw 的差异：不引入 antd，样式走 Tailwind + 项目已有 CSS 变量；
 * 砍掉了其 offload（转后台）控制条。
 */
export const ToolCardShell = React.memo<ToolCardShellProps>(
  ({
    content,
    isStreaming = false,
    icon,
    title,
    inlineResult,
    badges,
    summaryAction,
    children,
    defaultExpanded = false,
  }) => {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [bodyMounted, setBodyMounted] = useState(defaultExpanded);
    const detailsRef = useRef<HTMLDetailsElement>(null);

    const isLoading = content.status === "calling" && isStreaming;
    const isError = content.status === "error";

    // 折叠时同步原生 open，避免与用户操作互相打架。
    useEffect(() => {
      if (detailsRef.current) detailsRef.current.open = expanded;
    }, [expanded]);

    const handleToggle = useCallback(
      (event: React.SyntheticEvent<HTMLDetailsElement>) => {
        const open = event.currentTarget.open;
        // 程序化改动 open 也会触发 toggle，不能当成用户意图。
        if (open === expanded) return;
        setExpanded(open);
        if (open) setBodyMounted(true);
      },
      [expanded]
    );

    const errorText =
      extractResultText(content.result) || stringifyResult(content.result);

    return (
      <div className="my-0.5 w-full max-w-full">
        <details
          ref={detailsRef}
          open={expanded}
          onToggle={handleToggle}
          className={cn(
            "w-full max-w-full rounded-lg border border-transparent transition-colors",
            !expanded && "hover:bg-muted/60",
            expanded && "border-border bg-muted/30",
            isError && "border-destructive/30 bg-destructive/5"
          )}
        >
          <summary
            className={cn(
              "flex w-full cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden",
              isError
                ? "text-destructive"
                : "text-[var(--color-text-secondary)]"
            )}
          >
            <span className="flex shrink-0 items-center justify-center">
              {isLoading ? (
                <Loader2
                  size={13}
                  className="animate-spin"
                />
              ) : isError ? (
                <AlertCircle size={13} />
              ) : (
                <span className="flex items-center">{icon}</span>
              )}
            </span>

            <span
              className="min-w-0 max-w-[60%] flex-1 truncate text-left font-medium"
              title={title}
            >
              {title}
              {isLoading ? ` ${zh.tool.loading}` : ""}
            </span>

            {summaryAction}
            {!isLoading && badges}
            {inlineResult && (
              <span
                className={cn(
                  "min-w-0 flex-shrink truncate text-xxs",
                  isError
                    ? "text-destructive/90"
                    : "text-[var(--color-text-tertiary)]"
                )}
                title={inlineResult}
              >
                {inlineResult}
              </span>
            )}
          </summary>

          {bodyMounted && (
            <div className="px-2 pb-2 pt-1">
              {isError ? (
                <>
                  {Object.keys(content.rawInput).length > 0 && (
                    <DefaultBlock
                      title={zh.tool.sectionInput}
                      content={JSON.stringify(content.rawInput, null, 2)}
                    />
                  )}
                  {content.interrupted && (
                    <DefaultBlock
                      title={zh.tool.interruptedTitle}
                      content={zh.tool.interrupted}
                    />
                  )}
                  {errorText && (
                    <DefaultBlock
                      title={zh.tool.sectionError}
                      content={errorText}
                    />
                  )}
                </>
              ) : (
                children
              )}
            </div>
          )}
        </details>
      </div>
    );
  }
);

ToolCardShell.displayName = "ToolCardShell";

/**
 * 摘要行里显示的失败原因 —— 未展开也能看到，
 * 满足 specs/chat-ui「失败可见且不被内容淹没」。
 */
export function errorSummary(content: CardProps["content"]): string | null {
  if (content.status !== "error") return null;
  const text =
    extractResultText(content.result) || stringifyResult(content.result);
  if (!text) return content.interrupted ? zh.tool.interrupted : null;
  return oneLine(text, 90);
}

/** 徽标：行数 / 匹配数等，统一观感。 */
export function ToolBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "add" | "del" | "info";
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-xxs tabular-nums",
        tone === "add" && "bg-green-500/15 text-green-700 dark:text-green-300",
        tone === "del" && "bg-red-500/15 text-red-700 dark:text-red-300",
        tone === "info" && "bg-blue-500/15 text-blue-700 dark:text-blue-300",
        tone === "neutral" &&
          "bg-[var(--color-surface)] text-[var(--color-text-tertiary)]"
      )}
    >
      {children}
    </span>
  );
}