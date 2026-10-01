"use client";

import React from "react";
import { Bot, ListChecks, SquareTerminal, Wrench } from "lucide-react";
import { DefaultBlock } from "@/app/components/ToolCards/DefaultBlock";
import {
  ToolBadge,
  ToolCardShell,
  errorSummary,
} from "@/app/components/ToolCards/ToolCardShell";
import {
  countLines,
  extractResultText,
  oneLine,
  paramString,
  stringifyResult,
  type CardProps,
} from "@/app/components/ToolCards/types";
import zh, { t } from "@/i18n/zh";

/** 执行命令 */
export const ShellCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const command = paramString(content.params, "command");
  const title = command
    ? t(zh.tool.shell, { command: oneLine(command, 90) })
    : zh.tool.shellDefault;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<SquareTerminal size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  const lineCount = countLines(output);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<SquareTerminal size={13} />}
      title={title}
      badges={
        content.status === "done" && lineCount > 0 ? (
          <ToolBadge>{t(zh.tool.badgeLines, { count: lineCount })}</ToolBadge>
        ) : null
      }
    >
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
          language="bash"
        />
      )}
    </ToolCardShell>
  );
};

interface TodoEntry {
  content: string;
  status?: string;
}

/** 从参数里尽力取出待办条目（write_todos / todo_create 等形态不一）。 */
function extractTodos(params: Record<string, unknown>): TodoEntry[] {
  const raw =
    params["todos"] ?? params["items"] ?? params["todo"] ?? params["tasks"];
  if (!raw) return [];
  if (typeof raw === "string") {
    return raw.split("\n").filter(Boolean).map((content) => ({ content }));
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (typeof entry === "string") return { content: entry };
      const obj = (entry ?? {}) as Record<string, unknown>;
      const content =
        (obj["content"] as string) ??
        (obj["text"] as string) ??
        (obj["title"] as string) ??
        JSON.stringify(obj);
      return { content, status: obj["status"] as string | undefined };
    });
  }
  return [];
}

const STATUS_LABEL: Record<string, string> = {
  pending: zh.tasks.pending,
  in_progress: zh.tasks.inProgress,
  completed: zh.tasks.completed,
};

/**
 * 待办清单类工具。
 * 说明：本轮 TODO 的唯一事实源是工作区里的 `todos.json`（见 design.md Decisions #4），
 * 卡片只负责把这次调用的增删改呈现出来，不作为状态来源。
 */
export const TodoCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const title = zh.tool.todo;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<ListChecks size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const todos = extractTodos(content.params);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<ListChecks size={13} />}
      title={title}
      badges={
        todos.length > 0 ? (
          <ToolBadge>{t(zh.tool.badgeEntries, { count: todos.length })}</ToolBadge>
        ) : null
      }
    >
      {todos.length > 0 && (
        <ul className="my-1 space-y-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          {todos.map((todo, index) => (
            <li
              key={`${todo.content}-${index}`}
              className="flex items-start gap-2 text-xs leading-5 text-[var(--color-text-secondary)]"
            >
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--color-border)]" />
              <span className="min-w-0 flex-1 break-words">{todo.content}</span>
              {todo.status && (
                <span className="shrink-0 text-xxs text-[var(--color-text-tertiary)]">
                  {STATUS_LABEL[todo.status] ?? todo.status}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {todos.length === 0 && extractResultText(content.result) && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={extractResultText(content.result)}
        />
      )}
    </ToolCardShell>
  );
};

/** 子代理任务：摘要行显示子代理名，展开显示输入与结果。 */
export const AgentTaskCard: React.FC<CardProps> = ({ content, isStreaming }) => {
  const subagent =
    paramString(content.params, "subagent_type") ||
    paramString(content.params, "name");
  const title = subagent
    ? t(zh.tool.task, { name: subagent })
    : zh.tool.taskDefault;

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<Bot size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const description =
    paramString(content.params, "description") ||
    paramString(content.params, "prompt");
  const output = extractResultText(content.result);

  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Bot size={13} />}
      title={title}
      inlineResult={!output && description ? oneLine(description, 60) : null}
    >
      {description && (
        <DefaultBlock
          title={zh.tool.sectionInput}
          content={description}
        />
      )}
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
        />
      )}
    </ToolCardShell>
  );
};

/** 未登记工具的兜底：名称 + 参数 + 结果，绝不静默丢弃。 */
export const GenericToolCard: React.FC<CardProps> = ({
  content,
  isStreaming,
}) => {
  const toolLabel = content.name || zh.tool.unknownTool;
  const title = t(zh.tool.genericTitle, { tool: toolLabel });

  if (content.status === "error") {
    return (
      <ToolCardShell
        content={content}
        isStreaming={isStreaming}
        icon={<Wrench size={13} />}
        title={title}
        inlineResult={errorSummary(content)}
      />
    );
  }

  const output = extractResultText(content.result);
  return (
    <ToolCardShell
      content={content}
      isStreaming={isStreaming}
      icon={<Wrench size={13} />}
      title={title}
      inlineResult={!output ? stringifyResult(content.result) || null : null}
    >
      {Object.keys(content.params).length > 0 && (
        <DefaultBlock
          title={zh.tool.sectionInput}
          content={JSON.stringify(content.params, null, 2)}
        />
      )}
      {output && (
        <DefaultBlock
          title={zh.tool.sectionOutput}
          content={output}
        />
      )}
    </ToolCardShell>
  );
};