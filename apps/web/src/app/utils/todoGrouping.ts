/**
 * TODO 分组与进度（对齐 specs/file-workspace-ui「按状态分组呈现」）。
 * 纯逻辑，方便单测覆盖「三组同时存在 / 全空 / 部分为空」。
 */
import type { Todo, TodoStatus } from "@/lib/workspaceApi";

export interface TodoGroups {
  pending: Todo[];
  in_progress: Todo[];
  completed: Todo[];
}

export interface TodoProgress {
  done: number;
  total: number;
  /** 0-100 的整数，便于直接用于进度条宽度。 */
  percent: number;
}

/** 按状态分组；保持输入顺序（即文件中的顺序）。 */
export function groupTodos(todos: Todo[]): TodoGroups {
  const groups: TodoGroups = { pending: [], in_progress: [], completed: [] };
  for (const todo of todos) {
    groups[todo.status]?.push(todo);
  }
  return groups;
}

export function todoProgress(todos: Todo[]): TodoProgress {
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}

/** 分组渲染顺序：进行中 → 待办 → 已完成（把正在做的事放在最上面）。 */
export const GROUP_ORDER: TodoStatus[] = [
  "in_progress",
  "pending",
  "completed",
];

/** 状态三态的中文键（对应 i18n `zh.todos.*`）。 */
export const STATUS_LABEL_KEY: Record<TodoStatus, "pending" | "inProgress" | "completed"> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};