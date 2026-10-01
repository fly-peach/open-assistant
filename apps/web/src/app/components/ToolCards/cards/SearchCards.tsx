"use client";

import React from "react";
import { FolderOpen, ListTree, Search } from "lucide-react";
import { DefaultBlock } from "@/app/components/ToolCards/DefaultBlock";
import {
  ToolBadge,
  ToolCardShell,
  errorSummary,
} from "@/app/components/ToolCards/ToolCardShell";
import {
  extractResultText,
  paramString,
  stringifyResult,
  type CardProps,
} from "@/app/components/ToolCards/types";
import zh, { t } from "@/i18n/zh";

function countResultLines(text: string): number {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "").length;
}

/** 列出目录 */
export const ListDirCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const path = paramString(content.params, "path");
  const title = path ? t(zh.tool.ls, { path }) : zh.tool.lsDefault;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<ListTree size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  const count = countResultLines(output);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<ListTree size={13} />}
      title={title}
      badges={
        content.status === "done" && count > 0 ? (
          <ToolBadge>{t(zh.tool.badgeEntries, { count })}</ToolBadge>
        ) : null
      }
    >
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
        />
      )}
    </ToolCardShell>
  );
};

/** 通配匹配 */
export const GlobCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const pattern = paramString(content.params, "pattern");
  const title = pattern
    ? t(zh.tool.glob, { pattern })
    : zh.tool.globDefault;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<FolderOpen size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  const count = countResultLines(output);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<FolderOpen size={13} />}
      title={title}
      badges={
        content.status === "done" && count > 0 ? (
          <ToolBadge>{t(zh.tool.badgeFiles, { count })}</ToolBadge>
        ) : null
      }
    >
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
        />
      )}
    </ToolCardShell>
  );
};

/** 内容检索 */
export const GrepCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const pattern = paramString(content.params, "pattern");
  const title = pattern
    ? t(zh.tool.grep, { pattern })
    : zh.tool.grepDefault;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<Search size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  const count = countResultLines(output);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Search size={13} />}
      title={title}
      badges={
        content.status === "done" && count > 0 ? (
          <ToolBadge>{t(zh.tool.badgeMatches, { count })}</ToolBadge>
        ) : null
      }
      inlineResult={
        count === 0 && content.status === "done"
          ? stringifyResult(content.result) || null
          : null
      }
    >
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
        />
      )}
    </ToolCardShell>
  );
};