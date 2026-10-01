"use client";

import React, { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  WorkspaceApiError,
  readTodos,
  writeTodos,
  type Todo,
  type TodoStatus,
} from "@/lib/workspaceApi";
import {
  GROUP_ORDER,
  STATUS_LABEL_KEY,
  groupTodos,
  todoProgress,
} from "@/app/utils/todoGrouping";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";
import { isoToLocalInput, localInputToIso } from "@/app/utils/datetime";

const STATUS_CLASS: Record<TodoStatus, string> = {
  pending: "text-[var(--color-text-tertiary)]",
  in_progress: "text-[var(--color-warning)]",
  completed: "text-[var(--color-success)]",
};

const NEXT_STATUS: Record<TodoStatus, TodoStatus> = {
  pending: "in_progress",
  in_progress: "completed",
  completed: "pending",
};

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return <CheckCircle2 size={16} className={STATUS_CLASS.completed} />;
  }
  if (status === "in_progress") {
    return <Clock size={16} className={STATUS_CLASS.in_progress} />;
  }
  return <Circle size={16} className={STATUS_CLASS.pending} />;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

interface TodoViewProps {
  workspacePath: string;
  revision: number;
  onChanged: () => void;
}

/**
 * TODO 专用视图（对齐 specs/file-workspace-ui「TODO 专用视图」）。
 *
 * - 事实源是工作区内的 `todos.json`，这里通过 HTTP 读写（带 etag 乐观并发）；
 * - 按状态分组 + 进度；可改状态 / 改内容 / 删除 / 新增；
 * - 依赖 `revision` 重新拉取，agent 改动后无需手动刷新即反映。
 */
export function TodoView({ workspacePath, revision, onChanged }: TodoViewProps) {
  const { data, error, isLoading, mutate } = useSWR(
    ["todos", workspacePath, revision],
    () => readTodos(workspacePath),
    { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: false }
  );

  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingDue, setEditingDue] = useState("");
  const [newDue, setNewDue] = useState("");

  const todos = useMemo(() => data?.file.todos ?? [], [data]);
  const groups = useMemo(() => groupTodos(todos), [todos]);
  const progress = useMemo(() => todoProgress(todos), [todos]);
  const etag = data?.etag ?? null;

  const persist = useCallback(
    async (nextTodos: Todo[]) => {
      setBusy(true);
      setConflict(false);
      try {
        await writeTodos(
          workspacePath,
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            todos: nextTodos,
          },
          etag
        );
        await mutate();
        onChanged();
      } catch (err) {
        const apiErr = err as WorkspaceApiError;
        if (apiErr?.isConflict) {
          setConflict(true);
          await mutate();
        } else {
          toast.error(
            t(zh.todos.saveFailed, { error: apiErr?.message ?? String(err) })
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [workspacePath, etag, mutate, onChanged]
  );

  const cycleStatus = useCallback(
    (todo: Todo) => {
      const next = todos.map((item) =>
        item.id === todo.id
          ? {
              ...item,
              status: NEXT_STATUS[item.status],
              updatedAt: new Date().toISOString(),
            }
          : item
      );
      void persist(next);
    },
    [todos, persist]
  );

  const startEdit = useCallback((todo: Todo) => {
    setEditingId(todo.id);
    setEditingContent(todo.content);
    setEditingDue(isoToLocalInput(todo.dueAt));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingContent("");
    setEditingDue("");
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingId) return;
    const content = editingContent.trim();
    if (!content) {
      toast.error(zh.todos.contentEmpty);
      return;
    }
    const dueIso = localInputToIso(editingDue);
    const next = todos.map((item) => {
      if (item.id !== editingId) return item;
      const updated: Todo = { ...item, content, updatedAt: new Date().toISOString() };
      if (dueIso) updated.dueAt = dueIso;
      else delete updated.dueAt;
      return updated;
    });
    setEditingId(null);
    setEditingContent("");
    setEditingDue("");
    void persist(next);
  }, [editingId, editingContent, editingDue, todos, persist]);

  const removeTodo = useCallback(
    (todo: Todo) => {
      void persist(todos.filter((item) => item.id !== todo.id));
    },
    [todos, persist]
  );

  const addTodo = useCallback(() => {
    const content = newContent.trim();
    if (!content) return;
    const now = new Date().toISOString();
    const dueIso = localInputToIso(newDue);
    const todo: Todo = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `user-${Date.now()}`,
      content,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      source: "user",
      ...(dueIso ? { dueAt: dueIso } : {}),
    };
    setNewContent("");
    setNewDue("");
    void persist([...todos, todo]);
  }, [newContent, newDue, todos, persist]);

  if (error) {
    return (
      <div className="p-3 text-sm text-[var(--color-error)]">
        {t(zh.todos.loadFailed, {
          error: String((error as Error).message ?? error),
        })}
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-[var(--color-text-secondary)]">
        <Loader2 size={14} className="animate-spin" />
        {zh.common.loading}
      </div>
    );
  }

  const progressText =
    progress.total === 0
      ? t(zh.todos.countTotal, { count: 0 })
      : t(zh.todos.progress, { done: progress.done, total: progress.total });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{zh.todos.viewTitle}</span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {progressText}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface)]">
          <div
            className="h-full rounded-full bg-[var(--color-success)] transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {conflict && (
        <div className="flex items-center gap-2 border-b border-border bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-warning)]">
          <AlertTriangle size={13} />
          <span className="flex-1">{zh.todos.conflict}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {todos.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <p className="text-sm font-medium">{zh.todos.empty}</p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              {zh.todos.emptyHint}
            </p>
          </div>
        ) : (
          GROUP_ORDER.map((status) => {
            const items = groups[status];
            if (items.length === 0) return null;
            return (
              <section key={status} className="mb-4 last:mb-0">
                <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  <StatusIcon status={status} />
                  {zh.todos[STATUS_LABEL_KEY[status]]}
                  <span className="font-normal">({items.length})</span>
                </h3>
                <ul className="space-y-1">
                  {items.map((todo) => (
                    <li
                      key={todo.id}
                      className="group flex items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 hover:border-border hover:bg-[var(--color-surface)]"
                    >
                      <button
                        type="button"
                        onClick={() => cycleStatus(todo)}
                        disabled={busy}
                        title={zh.todos.statusMenu}
                        aria-label={zh.todos.statusMenu}
                        className="mt-0.5 shrink-0 disabled:opacity-50"
                      >
                        <StatusIcon status={todo.status} />
                      </button>

                      {editingId === todo.id ? (
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <textarea
                            value={editingContent}
                            onChange={(event) =>
                              setEditingContent(event.target.value)
                            }
                            rows={2}
                            className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-sm"
                          />
                          <input
                            type="datetime-local"
                            value={editingDue}
                            onChange={(event) => setEditingDue(event.target.value)}
                            aria-label={zh.todos.due}
                            title={zh.todos.dueHint}
                            data-todo-due-input
                            className="w-fit rounded border border-border bg-background px-2 py-1 text-xs"
                          />
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={saveEdit}
                              disabled={busy}
                              aria-label={zh.todos.save}
                              className="flex items-center gap-1 rounded bg-[var(--color-primary)] px-2 py-0.5 text-xs text-white disabled:opacity-50"
                            >
                              <Check size={12} />
                              {zh.todos.save}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              aria-label={zh.todos.cancel}
                              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs"
                            >
                              <X size={12} />
                              {zh.todos.cancel}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              "break-words text-sm",
                              todo.status === "completed" &&
                                "text-[var(--color-text-tertiary)] line-through"
                            )}
                          >
                            {todo.content}
                          </p>
                          <p className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                            {zh.todos.source}:{" "}
                            {todo.source === "user"
                              ? zh.todos.sourceUser
                              : zh.todos.sourceAgent}
                            {" · "}
                            {formatTime(todo.updatedAt)}
                          </p>
                          {todo.dueAt && (
                            <p
                              className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)]"
                              data-todo-due
                            >
                              <Calendar size={11} />
                              {zh.todos.due}：{new Date(todo.dueAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}

                      {editingId !== todo.id && (
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => startEdit(todo)}
                            disabled={busy}
                            aria-label={zh.todos.edit}
                            title={zh.todos.edit}
                            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-background disabled:opacity-50"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeTodo(todo)}
                            disabled={busy}
                            aria-label={zh.todos.delete}
                            title={zh.todos.delete}
                            className="rounded p-1 text-[var(--color-error)] hover:bg-background disabled:opacity-50"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <input
          value={newContent}
          onChange={(event) => setNewContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              addTodo();
            }
          }}
          placeholder={zh.todos.addPlaceholder}
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <input
          type="datetime-local"
          value={newDue}
          onChange={(event) => setNewDue(event.target.value)}
          aria-label={zh.todos.due}
          title={zh.todos.dueHint}
          data-todo-new-due
          className="shrink-0 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={addTodo}
          disabled={busy || newContent.trim().length === 0}
          className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-primary)] px-2.5 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
          {busy ? zh.todos.adding : zh.todos.add}
        </button>
      </div>
    </div>
  );
}

export default TodoView;