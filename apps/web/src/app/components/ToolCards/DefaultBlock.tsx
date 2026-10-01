"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import zh from "@/i18n/zh";
import { cn } from "@/lib/utils";

/** 超过这些阈值就不再做语法高亮（Prism 同步 tokenize 会冻结 UI 线程）。 */
const LARGE_CONTENT_CHARS = 100_000;
const LARGE_CONTENT_LINES = 1_000;
const HEAD_LINES = 200;
const TAIL_LINES = 300;
const EXCERPT_MAX_CHARS = 32_000;

interface Excerpt {
  head: string;
  tail: string;
  omittedLines: number;
}

function buildLargeExcerpt(content: string): Excerpt | null {
  const lines = content.split("\n");
  const tooLarge =
    content.length > LARGE_CONTENT_CHARS || lines.length > LARGE_CONTENT_LINES;
  if (!tooLarge) return null;

  const head = lines.slice(0, HEAD_LINES).join("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return {
    head: head.slice(0, EXCERPT_MAX_CHARS),
    tail: tail.slice(-EXCERPT_MAX_CHARS),
    omittedLines: Math.max(0, lines.length - HEAD_LINES - TAIL_LINES),
  };
}

function tryParseJson(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function looksLikeMarkdown(content: string): boolean {
  const head = content.slice(0, 2000);
  return /(^|\n)#{1,6}\s+\S/.test(head) || /(^|\n)\s*[-*]\s+\S/.test(head);
}

export interface DefaultBlockProps {
  title: string;
  content: string;
  /** 显式指定语法高亮语言（文件类卡片按扩展名传入）。 */
  language?: string;
  className?: string;
}

/**
 * 统一的「标题栏 + 复制按钮 + 内容区」块。
 *
 * 迁移自 QwenPaw `shared/DefaultBlock.tsx`，把其 antd / agentscope Markdown
 * 依赖换成本项目已有的 react-markdown + react-syntax-highlighter。
 */
export const DefaultBlock = React.memo<DefaultBlockProps>(
  ({ title, content, language, className }) => {
    const [copied, setCopied] = useState(false);
    const excerpt = useMemo(() => buildLargeExcerpt(content), [content]);
    const parsedJson = useMemo(
      () => (excerpt || language ? null : tryParseJson(content)),
      [content, excerpt, language]
    );
    const markdown = useMemo(
      () =>
        !excerpt &&
        !parsedJson &&
        (language === "markdown" || (!language && looksLikeMarkdown(content))),
      [content, excerpt, language, parsedJson]
    );

    const handleCopy = useCallback(() => {
      void navigator.clipboard?.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }, [content]);

    const highlighted = parsedJson ? JSON.stringify(parsedJson, null, 2) : content;
    const highlightLanguage = parsedJson ? "json" : language || "text";

    return (
      <div
        className={cn(
          "my-1 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]",
          className
        )}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] bg-muted/40 px-3 py-1.5">
          <span className="text-xxs font-medium tracking-wide text-[var(--color-text-tertiary)]">
            {title}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? zh.common.copied : zh.common.copy}
            aria-label={copied ? zh.common.copied : zh.common.copy}
            className="flex items-center text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="max-h-[300px] min-w-0 overflow-auto">
          {excerpt ? (
            <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-[var(--color-text-primary)]">
              {excerpt.head}
              {"\n"}
              {zh.tool.largeOmitted} {excerpt.omittedLines}
              {"\n"}
              {excerpt.tail}
            </pre>
          ) : markdown ? (
            <div className="p-3">
              <MarkdownContent content={content} />
            </div>
          ) : (
            <SyntaxHighlighter
              language={highlightLanguage}
              style={oneDark}
              customStyle={{
                margin: 0,
                background: "transparent",
                padding: "0.75rem",
                fontSize: "0.75rem",
                lineHeight: "1.25rem",
              }}
              wrapLongLines
            >
              {highlighted}
            </SyntaxHighlighter>
          )}
        </div>
      </div>
    );
  }
);

DefaultBlock.displayName = "DefaultBlock";

export const __testing = {
  buildLargeExcerpt,
  tryParseJson,
  looksLikeMarkdown,
  LARGE_CONTENT_CHARS,
  LARGE_CONTENT_LINES,
};