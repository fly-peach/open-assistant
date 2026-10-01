"use client";

import React from "react";
import { ArrowUpRight, FolderOpen, Sparkles } from "lucide-react";
import zh from "@/i18n/zh";

interface ChatWelcomeProps {
  /** 当前工作区绝对路径；为空表示尚未选择（此时不能对话，改为引导选目录）。 */
  workspacePath: string | null;
  /** 是否禁止交互（例如正在生成）。 */
  disabled?: boolean;
  /** 点建议卡片时把该句发出去。 */
  onSubmit: (text: string) => void;
  /** 未选工作区时点「选择本机目录」。 */
  onPickWorkspace: () => void;
}

/**
 * 空会话的首屏（欢迎界面）。
 *
 * 两态：
 * - **已选工作区**：给出问候 + 一句话说明 + 几个可点的建议指令（点一下直接发出），
 *   让用户不用对着空白输入框想「我该说什么」。
 * - **未选工作区**：不给建议指令（发了也会被后端拒绝），改为引导选一个本机目录。
 *
 * 说明：建议指令是**纯前端文案**，点一下走正常的 `sendMessage` 路径，
 * 不引入任何特殊通道 —— 它和用户手打一句完全等价。
 */
export const ChatWelcome = React.memo<ChatWelcomeProps>(
  ({ workspacePath, disabled = false, onSubmit, onPickWorkspace }) => {
    const w = zh.chat.welcome;
    const ready = Boolean(workspacePath);

    return (
      <section
        data-chat-welcome
        data-welcome-state={ready ? "ready" : "no-workspace"}
        className="mx-auto flex w-full max-w-[680px] flex-col items-center px-6 py-10 text-center"
      >
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-primary)]">
          <Sparkles size={20} aria-hidden />
        </div>

        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {ready ? w.greeting : w.noWorkspaceTitle}
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {ready ? w.description : w.noWorkspaceHint}
        </p>

        {ready ? (
          <div className="mt-7 w-full">
            <div className="mb-2 text-xs text-[var(--color-text-tertiary)]">
              {w.suggestionsLabel}
            </div>
            <div className="flex flex-col gap-2">
              {w.prompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSubmit(prompt)}
                  data-welcome-prompt
                  className="group flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate">{prompt}</span>
                  <ArrowUpRight
                    size={15}
                    aria-hidden
                    className="shrink-0 text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-primary)]"
                  />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onPickWorkspace}
            data-welcome-pick-workspace
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            <FolderOpen size={16} aria-hidden />
            {w.pickWorkspace}
          </button>
        )}
      </section>
    );
  }
);

ChatWelcome.displayName = "ChatWelcome";