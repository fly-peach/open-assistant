"use client";

import React, { useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

interface ThinkingBlockProps {
  content: string;
  /**
   * 该条消息是否正在流式生成。
   * 生成中默认展开 —— 否则思考阶段会是一段既没气泡也没指示器的空白（deep air）。
   */
  streaming?: boolean;
  /** 内嵌在回合过程里时用更紧凑的排版。 */
  compact?: boolean;
}

/**
 * 模型的思考过程（reasoning）展示块。
 *
 * 为什么需要它：模型是 reasoning 模型，思考写在 `reasoning_content` 里，
 * 而答案在 `content` 里。思考期间 `content` 一直是空串，基座 UI 只读
 * `content`，所以整个思考阶段界面毫无反馈。这个块把那段思考显式呈现出来。
 */
export const ThinkingBlock = React.memo<ThinkingBlockProps>(
  ({ content, streaming = false, compact = false }) => {
    // null = 跟随流式状态；用户手动点过之后就不再自动切换
    //（spec：结束后自动收起，但手动展开后 MUST NOT 被自动改回）
    const [userToggled, setUserToggled] = useState<boolean | null>(null);
    const expanded = userToggled ?? streaming;

    if (!content || content.trim() === "") return null;

    return (
      <div className={cn(compact ? "w-full" : "mt-4 w-full")}>
        <button
          type="button"
          onClick={() => setUserToggled(!expanded)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
        >
          <Brain
            size={13}
            className="shrink-0"
          />
          <span>
            {streaming ? zh.thinking.streaming : zh.thinking.done}
          </span>
          <span className="text-[var(--color-text-tertiary)]">
            {t(zh.thinking.charCount, { count: content.length })}
          </span>
          {expanded ? (
            <ChevronUp
              size={13}
              className="shrink-0"
            />
          ) : (
            <ChevronDown
              size={13}
              className="shrink-0"
            />
          )}
        </button>

        {expanded && (
          <div className="mt-2 rounded-md border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2">
            <div className="whitespace-pre-wrap break-words text-xs leading-[160%] text-[var(--color-text-secondary)]">
              {content}
            </div>
          </div>
        )}
      </div>
    );
  }
);

ThinkingBlock.displayName = "ThinkingBlock";