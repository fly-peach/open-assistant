"use client";

import React from "react";
import {
  AppendFileCard,
  DeleteFileCard,
  EditFileCard,
  ReadFileCard,
  SendFileCard,
  WriteFileCard,
} from "@/app/components/ToolCards/cards/FileCards";
import {
  GlobCard,
  GrepCard,
  ListDirCard,
} from "@/app/components/ToolCards/cards/SearchCards";
import {
  AgentTaskCard,
  GenericToolCard,
  ShellCard,
  TodoCard,
} from "@/app/components/ToolCards/cards/MiscCards";
import type { BuiltinCardComponent, CardProps } from "@/app/components/ToolCards/types";

export type { BuiltinCardComponent, CardProps };

export {
  DefaultBlock,
  type DefaultBlockProps,
} from "@/app/components/ToolCards/DefaultBlock";
export {
  ToolBadge,
  ToolCardShell,
  errorSummary,
  type ToolCardShellProps,
} from "@/app/components/ToolCards/ToolCardShell";
export * from "@/app/components/ToolCards/types";
export { GenericToolCard };

/**
 * 工具名 → 卡片组件。
 *
 * 照搬 QwenPaw 的静态 map 思路（`cards/index.ts`），并在其基础上：
 * - 补齐 DeepAgents 内置工具名（`ls` / `execute` / `delete` …）；
 * - 保留一批别名，避免因后端工具改名而退化为兜底。
 */
export const CARD_REGISTRY: Record<string, BuiltinCardComponent> = {
  // 文件读取
  read_file: ReadFileCard,
  read_text_file: ReadFileCard,
  read: ReadFileCard,
  // 文件写入
  write_file: WriteFileCard,
  create_file: WriteFileCard,
  write: WriteFileCard,
  // 文件修改
  edit_file: EditFileCard,
  str_replace: EditFileCard,
  replace_string_in_file: EditFileCard,
  apply_patch: EditFileCard,
  // 追写
  append_file: AppendFileCard,
  append_to_file: AppendFileCard,
  // 删除
  delete: DeleteFileCard,
  delete_file: DeleteFileCard,
  rm: DeleteFileCard,
  // 列表 / 匹配 / 检索
  ls: ListDirCard,
  list_dir: ListDirCard,
  list_directory: ListDirCard,
  glob: GlobCard,
  glob_search: GlobCard,
  find_files: GlobCard,
  grep: GrepCard,
  grep_search: GrepCard,
  search_content: GrepCard,
  // 执行（一个组件挂多个别名）
  execute: ShellCard,
  execute_shell_command: ShellCard,
  shell: ShellCard,
  bash: ShellCard,
  terminal: ShellCard,
  run_command: ShellCard,
  // 发送 / 预览文件
  send_file_to_user: SendFileCard,
  send_file: SendFileCard,
  view_image: SendFileCard,
  // 待办
  write_todos: TodoCard,
  todo_write: TodoCard,
  todo_list: TodoCard,
  todo_create: TodoCard,
  todo_update: TodoCard,
  todo_delete: TodoCard,
  // 子代理任务
  task: AgentTaskCard,
};

/**
 * 兜底解析：未登记的工具走 `GenericToolCard`，保证「不显示或报错」不会发生。
 * 同时兼容 `server__tool` 这类带命名空间前缀的名字（取最后一段再查一次）。
 */
export function resolveToolCard(
  name: string,
  registry: Record<string, BuiltinCardComponent> = CARD_REGISTRY
): BuiltinCardComponent {
  if (!name) return GenericToolCard;
  const direct = registry[name];
  if (direct) return direct;
  const base = name.split("__").pop() ?? name;
  const aliased = registry[base];
  if (aliased) return aliased;
  return GenericToolCard;
}

/**
 * 与 QwenPaw `withGenericFallback` 等价的兜底方案。
 *
 * 用途：注册表是**合并**出来的（内置 + 未来插件）时，替身比「catch-all 键」安全 ——
 * 但必须在所有合并完成之后再套，否则 `Object.assign` / spread 会丢掉替身行为。
 */
export function withGenericFallback(
  config: Record<string, BuiltinCardComponent>
): Record<string, BuiltinCardComponent> {
  return new Proxy(config, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return GenericToolCard;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Record<string, BuiltinCardComponent>;
}

/** 渲染入口：登记过的用专属卡片，未登记的兜底。 */
export function ToolCard({
  content,
  isStreaming,
}: CardProps): React.ReactElement {
  const Card = resolveToolCard(content.name);
  return (
    <Card
      content={content}
      isStreaming={isStreaming}
    />
  );
}