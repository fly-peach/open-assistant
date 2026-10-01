import { describe, expect, test } from "bun:test";
import { groupTodos, todoProgress } from "@/app/utils/todoGrouping";
import type { Todo, TodoStatus } from "@/lib/workspaceApi";

function todo(id: string, status: TodoStatus): Todo {
  return {
    id,
    content: `任务 ${id}`,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "user",
  };
}

describe("TODO 分组与进度（6.2）", () => {
  test("三组同时存在", () => {
    const groups = groupTodos([
      todo("a", "pending"),
      todo("b", "in_progress"),
      todo("c", "completed"),
      todo("d", "completed"),
    ]);
    expect(groups.pending.map((t) => t.id)).toEqual(["a"]);
    expect(groups.in_progress.map((t) => t.id)).toEqual(["b"]);
    expect(groups.completed.map((t) => t.id)).toEqual(["c", "d"]);
    expect(todoProgress([...groups.pending, ...groups.in_progress, ...groups.completed])).toEqual({
      done: 2,
      total: 4,
      percent: 50,
    });
  });

  test("全空", () => {
    const groups = groupTodos([]);
    expect(groups).toEqual({ pending: [], in_progress: [], completed: [] });
    expect(todoProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  test("部分为空", () => {
    const groups = groupTodos([todo("a", "pending"), todo("b", "pending")]);
    expect(groups.pending).toHaveLength(2);
    expect(groups.in_progress).toHaveLength(0);
    expect(groups.completed).toHaveLength(0);
    expect(todoProgress(groups.pending)).toEqual({
      done: 0,
      total: 2,
      percent: 0,
    });
  });

  test("全部完成时进度为 100", () => {
    expect(todoProgress([todo("a", "completed"), todo("b", "completed")])).toEqual({
      done: 2,
      total: 2,
      percent: 100,
    });
  });
});