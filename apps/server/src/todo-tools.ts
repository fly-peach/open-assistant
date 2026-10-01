/**
 * agent 的 TODO 工具：todo_list / todo_create / todo_update / todo_delete。
 *
 * 每个工具都只通过修改工作区内的 `todos.json` 生效（对齐 todo-store / agent 可读写 TODO）。
 * 工作区来自 run 的 `config.configurable.workspace`（工作区绝对路径）。
 */
import { tool } from "langchain";
import { z } from "zod";
import { createTodo, deleteTodo, readTodos, updateTodo } from "./todos.js";
import { errorText, workspaceDirOf } from "./tool-runtime.js";

export const todoListTool = tool(
  async (_input, runtime) => {
    try {
      const dir = await workspaceDirOf(runtime);
      const snapshot = await readTodos(dir);
      return JSON.stringify(
        {
          exists: snapshot.exists,
          etag: snapshot.etag,
          updatedAt: snapshot.file.updatedAt,
          todos: snapshot.file.todos,
        },
        null,
        2,
      );
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "todo_list",
    description: "列出当前工作区内的全部待办事项及其状态（读取 todos.json）。",
    schema: z.object({}),
  },
);

export const todoCreateTool = tool(
  async ({ content, status, due }, runtime) => {
    try {
      const dir = await workspaceDirOf(runtime);
      const { todo } = await createTodo(dir, {
        content,
        status,
        source: "agent",
        ...(due ? { dueAt: due } : {}),
      });
      return JSON.stringify({ ok: true, todo }, null, 2);
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "todo_create",
    description:
      "在当前工作区新增一条待办，写入 todos.json。status 可省略，默认 pending（待办）；" +
      "若这件事有明确的时间点，把 due 填上（ISO 时间），日历视图会按它排期。",
    schema: z.object({
      content: z.string().min(1).describe("待办内容"),
      status: z
        .enum(["pending", "in_progress", "completed"])
        .optional()
        .describe("状态：pending 待办 / in_progress 进行中 / completed 已完成"),
      due: z.string().optional().describe("计划时间（ISO 时间字符串，如 2026-10-03T09:00:00+08:00）"),
    }),
  },
);

export const todoUpdateTool = tool(
  async ({ id, content, status, due }, runtime) => {
    try {
      const dir = await workspaceDirOf(runtime);
      const { todo } = await updateTodo(dir, id, {
        ...(content !== undefined ? { content } : {}),
        ...(status !== undefined ? { status } : {}),
        // due 传空串 = 清掉排期
        ...(due !== undefined ? { dueAt: due.length > 0 ? due : null } : {}),
      });
      return JSON.stringify({ ok: true, todo }, null, 2);
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "todo_update",
    description:
      "更新某条待办的状态 / 内容 / 计划时间（按 id），只影响目标条目。id 不存在会返回 ERROR [TODO_NOT_FOUND]。",
    schema: z.object({
      id: z.string().min(1).describe("待办 id"),
      content: z.string().min(1).optional().describe("新的待办内容"),
      status: z
        .enum(["pending", "in_progress", "completed"])
        .optional()
        .describe("新状态：pending / in_progress / completed"),
      due: z.string().optional().describe("新的计划时间（ISO 时间）；传空字符串表示清掉排期"),
    }),
  },
);

export const todoDeleteTool = tool(
  async ({ id }, runtime) => {
    try {
      const dir = await workspaceDirOf(runtime);
      await deleteTodo(dir, id);
      return JSON.stringify({ ok: true, deleted: id }, null, 2);
    } catch (err) {
      return errorText(err);
    }
  },
  {
    name: "todo_delete",
    description: "删除某条待办（按 id），只影响目标条目。id 不存在会返回 ERROR [TODO_NOT_FOUND]。",
    schema: z.object({
      id: z.string().min(1).describe("待办 id"),
    }),
  },
);

export const todoTools = [todoListTool, todoCreateTool, todoUpdateTool, todoDeleteTool];