"use client";

/** 待办页（路由 `/todos`，导航数据表里的「内置」条目）。 */
import zh from "@/i18n/zh";
import { TodoBoard } from "@/app/_shell/TodoBoard";

export default function TodosPage() {
  return (
    <TodoBoard
      title={zh.shell.todoPageTitle}
      hint={zh.shell.todoPageHint}
    />
  );
}