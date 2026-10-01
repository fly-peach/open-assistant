/**
 * 第 2 组验收测试：会话库（thread / turn / message 三层）。
 *
 * 必须用 Node 跑（不能用 bun test）：本测试直接碰 SQLite（`node:sqlite`）。
 * 运行：`bun run test:conversation`（内部先 tsc 编译到 node_modules/.cache 再 node --test）。
 *
 * 覆盖 tasks 2.1–2.9 与 spec `session-store` 的全部 scenario。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  CONVERSATION_SCHEMA_VERSION,
  EXPECTED_COLUMNS,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  MESSAGES_TABLE,
  THREADS_TABLE,
  TURNS_TABLE,
  appendMessage,
  closeAllConversationDbs,
  closeConversationDb,
  conversationDbExists,
  conversationDbPath,
  createAgentCallThread,
  createCalledThread,
  createThread,
  defaultTitleFromUserContent,
  deleteAllConversations,
  deleteThread,
  findThreadsByPeerThreadId,
  finishTurn,
  getThread,
  getTurn,
  getTurnByIndex,
  listChildThreads,
  listOrphanThreads,
  listSessions,
  listThreads,
  listTurns,
  openConversationDb,
  readThreadMessages,
  readTurnMessages,
  recordTurn,
  removeConversationDb,
  startTurn,
  updateThread,
  updateThreadStatus,
  updateThreadTitle,
  upsertRecordedTurn,
  recordTurnToWorkspace,
  buildReplayContext,
  compactThread,
  compactThreadIfNeeded,
  pruneThreadHistory,
  readCompaction,
  resolveCompactionConfig,
  searchThreadMessages,
} from "../src/conversation/index.js";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { listWorkspaceSessions } from "../src/conversation/session-list.js";

type Row = Record<string, unknown>;

const WS_ROOT = path.join(os.tmpdir(), `oa-conversation-test-${process.pid}-${Date.now()}`);

async function makeWorkspace(name: string): Promise<string> {
  const dir = path.join(WS_ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  return await fs.realpath(dir);
}

async function dropWorkspace(dir: string): Promise<void> {
  closeConversationDb(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

function all(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

function countOf(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row | undefined;
  return Number(row?.["n"] ?? 0);
}

test.after(async () => {
  closeAllConversationDbs();
  await fs.rm(WS_ROOT, { recursive: true, force: true });
});

// —— 2.1 建表 ——

test("2.1 建库：sessions.sqlite 落在 .open-assistant/，三张表 + 索引齐全、字段照 D4", async () => {
  const ws = await makeWorkspace("schema");
  try {
    const dbPath = conversationDbPath(ws);
    assert.equal(
      dbPath,
      path.join(ws, ".open-assistant", "sessions.sqlite"),
      "库文件必须位于 <工作区>/.open-assistant/sessions.sqlite",
    );
    assert.equal(await conversationDbExists(ws), false, "未打开前不应存在");
    const db = openConversationDb(ws);
    assert.equal(await conversationDbExists(ws), true, "打开后库文件存在");

    const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r["name"]);
    for (const table of EXPECTED_TABLES) {
      assert.ok(tables.includes(table), `缺少表 ${table}（实际 ${tables.join(",")}）`);
    }
    assert.equal(EXPECTED_TABLES.length, 3, "三层结构：threads / turns / messages");

    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = all(db, `PRAGMA table_info(${table})`).map((r) => String(r["name"]));
      assert.deepEqual(actual, expected, `${table} 字段应与 design D4 一致`);
    }

    const indexes = all(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
    ).map((r) => String(r["name"]));
    for (const idx of EXPECTED_INDEXES) {
      assert.ok(indexes.includes(idx), `缺少索引 ${idx}（实际 ${indexes.join(",")}）`);
    }

    const version = all(db, "PRAGMA user_version")[0];
    assert.equal(Number(Object.values(version)[0]), CONVERSATION_SCHEMA_VERSION);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.2 一轮落库 ——

test("2.2 一轮落库：三张表记录数与顺序正确，用户输入同时进 turn 与 messages", async () => {
  const ws = await makeWorkspace("one-turn");
  try {
    const thread = createThread(ws, { agentId: "agent-a", kind: "main" });
    assert.equal(thread.title, null, "建会话时标题为空，等首条用户输入生成");

    const result = recordTurn(ws, {
      threadId: thread.id,
      userContent: "hello",
      messages: [
        { role: "ai", kind: "text", content: "world" },
        { role: "tool", kind: "tool-call", toolName: "read_file", toolCallId: "call_1", content: "{\"path\":\"a\"}" },
        { role: "tool", kind: "tool-result", toolName: "read_file", toolCallId: "call_1", content: "abc" },
        { role: "ai", kind: "text", content: "done" },
      ],
    });

    const db = openConversationDb(ws);
    assert.equal(countOf(db, THREADS_TABLE), 1);
    assert.equal(countOf(db, TURNS_TABLE), 1);
    assert.equal(countOf(db, MESSAGES_TABLE), 5, "human + 4 条");

    assert.equal(result.turn.idx, 0);
    assert.equal(result.turn.status, "done");
    assert.equal(result.turn.userContent, "hello");
    assert.equal(result.turn.startedAt !== null, true);
    assert.equal(result.turn.endedAt !== null, true);

    const messages = readThreadMessages(ws, thread.id);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["human", "ai", "tool", "tool", "ai"],
      "顺序必须与发生顺序一致",
    );
    assert.deepEqual(
      messages.map((m) => m.seq),
      [0, 1, 2, 3, 4],
      "seq 从 0 起严格递增",
    );
    assert.equal(messages[0].content, "hello", "用户输入同时作为 messages 的第一条");
    assert.equal(messages[2].toolCallId, "call_1");
    assert.equal(messages[2].toolName, "read_file");

    // 会话被自动补上默认标题
    assert.equal(getThread(ws, thread.id)?.title, "hello");
  } finally {
    await dropWorkspace(ws);
  }
});

test("2.2b 流式路径：startTurn(running) → appendMessage → finishTurn(done)", async () => {
  const ws = await makeWorkspace("stream-turn");
  try {
    const thread = createThread(ws, { agentId: "agent-a" });
    const turn = startTurn(ws, { threadId: thread.id, userContent: "stream" });
    assert.equal(turn.status, "running");
    assert.equal(getTurnByIndex(ws, thread.id, 0)?.status, "running");

    appendMessage(ws, { threadId: thread.id, turnId: turn.id, role: "ai", kind: "text", content: "chunk-1" });
    appendMessage(ws, { threadId: thread.id, turnId: turn.id, role: "ai", kind: "text", content: "chunk-2" });
    const finished = finishTurn(ws, turn.id, { status: "done" });
    assert.equal(finished.status, "done");
    assert.deepEqual(
      readThreadMessages(ws, thread.id).map((m) => m.seq),
      [0, 1, 2],
    );
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.3 顺序稳定 ——

test("2.3 多次读取顺序稳定；可按 (会话, 轮次序号) 定位", async () => {
  const ws = await makeWorkspace("stable-order");
  try {
    const thread = createThread(ws, { agentId: "agent-a" });
    recordTurn(ws, { threadId: thread.id, userContent: "t0", messages: [{ role: "ai", kind: "text", content: "a0" }] });
    recordTurn(ws, { threadId: thread.id, userContent: "t1", messages: [{ role: "ai", kind: "text", content: "a1" }] });
    recordTurn(ws, { threadId: thread.id, userContent: "t2", messages: [{ role: "ai", kind: "text", content: "a2" }] });

    const first = readThreadMessages(ws, thread.id);
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(readThreadMessages(ws, thread.id), first, `第 ${i + 2} 次读取应完全一致`);
    }
    assert.deepEqual(
      first.map((m) => m.content),
      ["t0", "a0", "t1", "a1", "t2", "a2"],
    );

    const turn1 = readTurnMessages(ws, thread.id, 1);
    assert.deepEqual(
      turn1.map((m) => m.content),
      ["t1", "a1"],
      "按轮次序号读取只返回该轮",
    );
    assert.equal(getTurnByIndex(ws, thread.id, 2)?.userContent, "t2");
    assert.equal(listTurns(ws, thread.id).length, 3);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.4 轮次状态 ——

test("2.4 三种轮次状态（done / cancelled / error）可辨认，running 亦可见", async () => {
  const ws = await makeWorkspace("turn-status");
  try {
    const thread = createThread(ws, { agentId: "agent-a" });
    recordTurn(ws, { threadId: thread.id, userContent: "ok", status: "done" });
    recordTurn(ws, { threadId: thread.id, userContent: "cancel", status: "cancelled" });
    recordTurn(ws, { threadId: thread.id, userContent: "boom", status: "error" });
    startTurn(ws, { threadId: thread.id, userContent: "pending" });

    const statuses = listTurns(ws, thread.id).map((t) => t.status);
    assert.deepEqual(statuses, ["done", "cancelled", "error", "running"]);
    assert.equal(getTurnByIndex(ws, thread.id, 1)?.status, "cancelled");
    assert.equal(getTurnByIndex(ws, thread.id, 2)?.status, "error");

    const summary = listSessions(ws, { kinds: ["main"] })[0];
    assert.equal(summary.unfinishedTurnCount, 3, "cancelled / error / running 都算未正常结束");
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.5 子会话 ——

test("2.5 子会话独立成行且不混入主会话消息序列", async () => {
  const ws = await makeWorkspace("subagent");
  try {
    const main = createThread(ws, { agentId: "agent-a", kind: "main" });
    recordTurn(ws, {
      threadId: main.id,
      userContent: "delegate",
      messages: [
        { role: "ai", kind: "tool-call", toolName: "task", toolCallId: "call_task_1", content: "{}" },
        { role: "tool", kind: "tool-result", toolName: "task", toolCallId: "call_task_1", content: "child done" },
      ],
    });

    const child = createThread(ws, {
      agentId: "agent-a",
      kind: "subagent",
      parentThreadId: main.id,
      parentToolCallId: "call_task_1",
    });
    recordTurn(ws, {
      threadId: child.id,
      userContent: "sub task",
      messages: [{ role: "ai", kind: "text", content: "sub answer" }],
    });

    const mainMessages = readThreadMessages(ws, main.id);
    assert.deepEqual(
      mainMessages.map((m) => m.content),
      ["delegate", "{}", "child done"],
      "子会话消息不得混入主会话序列",
    );
    assert.ok(
      mainMessages.every((m) => m.threadId === main.id),
      "主会话读到的每条消息 thread_id 都应是主会话",
    );

    const children = listChildThreads(ws, main.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, child.id);
    assert.equal(children[0].kind, "subagent");
    assert.equal(children[0].parentThreadId, main.id);
    assert.equal(children[0].parentToolCallId, "call_task_1");

    const childMessages = readThreadMessages(ws, child.id);
    assert.deepEqual(
      childMessages.map((m) => m.content),
      ["sub task", "sub answer"],
      "子会话可单独查看",
    );

    // 顶层会话列表默认不混入子会话
    const sessionIds = listSessions(ws).map((s) => s.id);
    assert.deepEqual(sessionIds, [main.id]);
    assert.equal(listThreads(ws, { kinds: ["subagent"] }).length, 1);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.6 跨工作区调用 ——

test("2.6 跨工作区调用两侧记录可互相追溯（对端 agent + 对端会话标识 + 发起方）", async () => {
  const wsA = await makeWorkspace("cross-a");
  const wsB = await makeWorkspace("cross-b");
  try {
    const mainA = createThread(wsA, { agentId: "agent-A", kind: "main" });
    const called = createCalledThread(wsB, {
      agentId: "agent-B",
      initiatorAgentId: "agent-A",
      initiatorThreadId: mainA.id,
      title: "被 A 调用",
    });
    const callSide = createAgentCallThread(wsA, {
      agentId: "agent-A",
      peerAgentId: "agent-B",
      peerThreadId: called.id,
      parentThreadId: mainA.id,
      parentToolCallId: "call_agent_1",
    });

    // A 侧
    assert.equal(callSide.kind, "agent-call");
    assert.equal(callSide.peerAgentId, "agent-B");
    assert.equal(callSide.peerThreadId, called.id, "A 侧标明对端会话标识");
    assert.equal(callSide.parentThreadId, mainA.id);
    assert.equal(callSide.parentToolCallId, "call_agent_1");

    // B 侧
    const bRecord = getThread(wsB, called.id);
    assert.equal(bRecord?.agentId, "agent-B");
    assert.equal(bRecord?.initiatorAgentId, "agent-A", "B 侧标明发起方 agent");
    assert.equal(bRecord?.initiatorThreadId, mainA.id, "B 侧标明发起方会话标识");

    // 两侧可反查
    assert.deepEqual(
      findThreadsByPeerThreadId(wsA, called.id).map((t) => t.id),
      [callSide.id],
    );
    assert.equal(getThread(wsB, callSide.id), null, "对端会话记录只在各自工作区");

    // B 侧是主会话，会出现在 B 的会话列表里
    assert.deepEqual(
      listSessions(wsB).map((s) => s.id),
      [called.id],
    );
  } finally {
    await dropWorkspace(wsA);
    await dropWorkspace(wsB);
  }
});

// —— 2.7 会话列表 ——

test("2.7 会话列表含非活跃会话、按最近活动倒序、默认标题、完整标识可见", async () => {
  const ws = await makeWorkspace("list");
  try {
    const older = createThread(ws, {
      agentId: "agent-a",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      title: "旧会话",
    });
    const archived = createThread(ws, {
      agentId: "agent-a",
      status: "archived",
      createdAt: "2024-02-01T00:00:00.000Z",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });
    const errored = createThread(ws, {
      agentId: "agent-a",
      status: "error",
      createdAt: "2024-03-01T00:00:00.000Z",
      updatedAt: "2024-03-01T00:00:00.000Z",
      title: "出错会话",
    });
    const latest = createThread(ws, {
      agentId: "agent-a",
      createdAt: "2024-04-01T00:00:00.000Z",
      updatedAt: "2024-04-01T00:00:00.000Z",
    });
    recordTurn(ws, { threadId: latest.id, userContent: "最新一轮" });

    // 子会话虽然最近，但不进顶层列表
    createThread(ws, {
      agentId: "agent-a",
      kind: "subagent",
      parentThreadId: older.id,
      updatedAt: "2099-01-01T00:00:00.000Z",
    });

    const sessions = listSessions(ws);
    assert.deepEqual(
      sessions.map((s) => s.id),
      [latest.id, errored.id, archived.id, older.id],
      "按最近活动（updated_at）倒序，非活跃不沉底",
    );
    assert.ok(sessions.some((s) => s.status === "archived"), "列表包含已释放资源的会话");
    assert.ok(sessions.some((s) => s.status === "error"));
    assert.ok(sessions.every((s) => s.id.length === 36), "对外是完整 uuid");

    const archivedSummary = sessions.find((s) => s.id === archived.id);
    assert.equal(archivedSummary?.status, "archived");
    assert.equal(archivedSummary?.title, "未命名会话", "无用户输入时回退默认标题");

    // 标题可改
    updateThreadTitle(ws, archived.id, "归档会话");
    assert.equal(getThread(ws, archived.id)?.title, "归档会话");
    updateThread(ws, older.id, { metaPatch: { tag: "x" } });
    assert.equal(getThread(ws, older.id)?.meta?.["tag"], "x");

    // 非活跃可显式标记
    updateThreadStatus(ws, older.id, "archived");
    assert.equal(getThread(ws, older.id)?.status, "archived");
  } finally {
    await dropWorkspace(ws);
  }
});

test("2.7b 默认标题取首条用户输入前 24 字", () => {
  assert.equal(defaultTitleFromUserContent("你好世界"), "你好世界");
  assert.equal(defaultTitleFromUserContent("\n\n  第二行才有效  \n更多"), "第二行才有效");
  const long = "一".repeat(30);
  assert.equal(Array.from(defaultTitleFromUserContent(long)).length, 24);
  assert.equal(defaultTitleFromUserContent("   \n  "), "未命名会话");
});

// —— 2.8 父会话删除时子记录处置 ——

test("2.8a 父会话删除（cascade，默认）：子会话与孙会话一并删除，不留不可达数据", async () => {
  const ws = await makeWorkspace("delete-cascade");
  try {
    const parent = createThread(ws, { agentId: "agent-a", kind: "main" });
    recordTurn(ws, { threadId: parent.id, userContent: "p", messages: [{ role: "ai", kind: "text", content: "p0" }] });
    const child = createThread(ws, { agentId: "agent-a", kind: "subagent", parentThreadId: parent.id, parentToolCallId: "c1" });
    recordTurn(ws, { threadId: child.id, userContent: "c", messages: [{ role: "ai", kind: "text", content: "c0" }] });
    const grand = createThread(ws, { agentId: "agent-a", kind: "subagent", parentThreadId: child.id, parentToolCallId: "c2" });
    recordTurn(ws, { threadId: grand.id, userContent: "g", messages: [{ role: "ai", kind: "text", content: "g0" }] });

    const result = deleteThread(ws, parent.id);
    assert.deepEqual(new Set(result.deletedThreadIds), new Set([parent.id, child.id, grand.id]));
    assert.deepEqual(result.detachedChildIds, []);

    assert.equal(getThread(ws, parent.id), null);
    assert.equal(getThread(ws, child.id), null);
    assert.equal(getThread(ws, grand.id), null);
    const db = openConversationDb(ws);
    assert.equal(countOf(db, THREADS_TABLE), 0);
    assert.equal(countOf(db, TURNS_TABLE), 0, "轮次随会话级联删除");
    assert.equal(countOf(db, MESSAGES_TABLE), 0, "消息随会话级联删除");
  } finally {
    await dropWorkspace(ws);
  }
});

test("2.8b 父会话删除（detach）：子会话保留为孤儿，仍可检索到", async () => {
  const ws = await makeWorkspace("delete-detach");
  try {
    const parent = createThread(ws, { agentId: "agent-a", kind: "main" });
    const child = createThread(ws, { agentId: "agent-a", kind: "subagent", parentThreadId: parent.id, parentToolCallId: "c1" });
    recordTurn(ws, { threadId: child.id, userContent: "child", messages: [{ role: "ai", kind: "text", content: "child-answer" }] });

    const result = deleteThread(ws, parent.id, { childAction: "detach" });
    assert.deepEqual(result.deletedThreadIds, [parent.id]);
    assert.deepEqual(result.detachedChildIds, [child.id]);
    assert.equal(getThread(ws, parent.id), null);

    const kept = getThread(ws, child.id);
    assert.ok(kept, "孤儿会话必须仍然存在，不得静默丢弃");
    assert.equal(kept?.parentThreadId, null);
    assert.equal(kept?.parentToolCallId, null);
    assert.equal(kept?.meta?.["orphaned"], true);
    assert.deepEqual(
      listOrphanThreads(ws).map((t) => t.id),
      [child.id],
      "孤儿会话可被显式检索到（可达）",
    );
    assert.equal(readThreadMessages(ws, child.id).length, 2, "孤儿会话内容仍在");
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 2.9 删除工作区目录 ——

test("2.9 删除工作区目录后，其会话与子会话一并消失（不再产生孤儿数据）", async () => {
  const ws = await makeWorkspace("removed-ws");
  try {
    const main = createThread(ws, { agentId: "agent-a", kind: "main" });
    recordTurn(ws, { threadId: main.id, userContent: "hi", messages: [{ role: "ai", kind: "text", content: "yo" }] });
    const child = createThread(ws, { agentId: "agent-a", kind: "subagent", parentThreadId: main.id, parentToolCallId: "c1" });
    recordTurn(ws, { threadId: child.id, userContent: "sub", messages: [{ role: "ai", kind: "text", content: "sub" }] });
    const dbPath = conversationDbPath(ws);
    assert.equal(await conversationDbExists(ws), true);

    // 删除工作区目录前必须先释放 sqlite 句柄（Windows 文件锁）
    closeConversationDb(ws);
    await fs.rm(ws, { recursive: true, force: true });

    assert.equal(await conversationDbExists(ws), false, "库文件随工作区目录消失");
    await assert.rejects(() => fs.stat(dbPath));
    assert.equal(await fs.stat(ws).catch(() => null), null, "工作区目录本身已删");

    // 重新按同一路径打开：不应再看到任何旧会话 / 子会话（无孤儿）
    const reopened = openConversationDb(ws);
    assert.equal(countOf(reopened, THREADS_TABLE), 0);
    assert.equal(countOf(reopened, TURNS_TABLE), 0);
    assert.equal(countOf(reopened, MESSAGES_TABLE), 0);
    closeConversationDb(ws);
  } finally {
    await dropWorkspace(ws);
  }
});

test("2.9b removeConversationDb 显式移除（工作区删除动作走它）", async () => {
  const ws = await makeWorkspace("remove-db");
  try {
    const t = createThread(ws, { agentId: "agent-a" });
    recordTurn(ws, { threadId: t.id, userContent: "x" });
    const dbPath = conversationDbPath(ws);
    assert.equal(await conversationDbExists(ws), true);
    await removeConversationDb(ws);
    assert.equal(await conversationDbExists(ws), false);
    for (const suffix of ["-wal", "-shm"]) {
      assert.equal(await fs.stat(dbPath + suffix).catch(() => null), null);
    }
    // 目录本身保留（只清会话数据）
    assert.ok(await fs.stat(ws));
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 补充：批量删除 / 计数 ——

test("deleteAllConversations 清空会话数据但保留库文件", async () => {
  const ws = await makeWorkspace("clear-all");
  try {
    const a = createThread(ws, { agentId: "agent-a" });
    const b = createThread(ws, { agentId: "agent-a", kind: "subagent", parentThreadId: a.id });
    recordTurn(ws, { threadId: a.id, userContent: "a" });
    recordTurn(ws, { threadId: b.id, userContent: "b" });
    const deleted = deleteAllConversations(ws);
    assert.equal(deleted, 2);
    assert.equal(countOf(openConversationDb(ws), THREADS_TABLE), 0);
    assert.equal(await conversationDbExists(ws), true);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 补充：落库（`workspaceMiddleware.afterAgent` 的写入口）——

test("upsertRecordedTurn：同 turnId 重复调用整体替换，不追加（afterAgent 多次触发安全）", async () => {
  const ws = await makeWorkspace("upsert-turn");
  try {
    const t = createThread(ws, { agentId: "life" });
    upsertRecordedTurn(ws, {
      threadId: t.id,
      turnId: "fixed",
      userContent: "第一版",
      messages: [{ role: "ai", kind: "text", content: "草稿" }],
    });
    upsertRecordedTurn(ws, {
      threadId: t.id,
      turnId: "fixed",
      userContent: "第一版",
      messages: [
        { role: "ai", kind: "text", content: "终稿" },
        { role: "tool", kind: "tool-result", content: "r", toolName: "x", toolCallId: "c1" },
      ],
    });
    const turns = listTurns(ws, t.id);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.status, "done");
    assert.deepEqual(
      readThreadMessages(ws, t.id).map((m) => `${m.role}/${m.kind}:${m.content}`),
      ["human/text:第一版", "ai/text:终稿", "tool/tool-result:r"],
    );
  } finally {
    await dropWorkspace(ws);
  }
});

test("recordTurnToWorkspace：从消息序列切出最后一轮落库（建会话 + 默认标题），幂等替换", async () => {
  const ws = await makeWorkspace("record-turn-we");
  try {
    const threadId = "thread-xyz";
    recordTurnToWorkspace(ws, {
      threadId,
      agentId: "life",
      messages: [new HumanMessage({ id: "h1", content: "建个待办" }), new AIMessage("好的")],
    });
    // 同一轮再次收尾：整体替换，不重复追加
    recordTurnToWorkspace(ws, {
      threadId,
      agentId: "life",
      messages: [new HumanMessage({ id: "h1", content: "建个待办" }), new AIMessage("已创建")],
    });
    const thread = getThread(ws, threadId);
    assert.ok(thread);
    assert.equal(thread!.agentId, "life");
    assert.equal(thread!.title, "建个待办");
    assert.equal(listTurns(ws, threadId).length, 1);
    assert.deepEqual(
      readThreadMessages(ws, threadId).map((m) => `${m.role}:${m.content}`),
      ["human:建个待办", "ai:已创建"],
    );
  } finally {
    await dropWorkspace(ws);
  }
});

test("recordTurnToWorkspace：没有用户消息 → 不建会话、不落库", async () => {
  const ws = await makeWorkspace("record-none");
  try {
    const wrote = recordTurnToWorkspace(ws, {
      threadId: "t",
      agentId: "life",
      messages: [new AIMessage("只有回答")],
    });
    assert.equal(wrote, false);
    assert.equal(getThread(ws, "t"), null);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 补充：热冷合并列表（记录来自会话库，状态来自平台；缺的历史 thread 被导入）——

test("listWorkspaceSessions：会话库记录 + 平台实时状态叠加 + 导入未落库的历史 thread", async () => {
  const ws = await makeWorkspace("session-list");
  try {
    const existing = createThread(ws, { id: "t-existing", agentId: "life", title: "已有" });
    recordTurn(ws, {
      threadId: existing.id,
      userContent: "hi",
      messages: [{ role: "ai", kind: "text", content: "ho" }],
    });
    const platform = [
      { thread_id: "t-existing", status: "busy", values: { messages: [] } },
      {
        thread_id: "t-legacy",
        status: "idle",
        values: { messages: [{ type: "human", content: "历史第一条消息" }] },
      },
    ];
    const client = { threads: { search: async () => platform } } as never;
    const items = await listWorkspaceSessions(ws, { client });
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(byId.get("t-existing")!.liveStatus, "busy");
    assert.equal(byId.get("t-existing")!.agentId, "life");
    assert.equal(byId.get("t-existing")!.turnCount, 1);

    // 历史 thread 被导入会话库，标题取首条用户输入
    assert.ok(getThread(ws, "t-legacy"));
    assert.equal(byId.get("t-legacy")!.title, "历史第一条消息");
    assert.equal(byId.get("t-legacy")!.liveStatus, "idle");
  } finally {
    await dropWorkspace(ws);
  }
});

test("listWorkspaceSessions：平台不可用时降级为只列会话库记录（liveStatus=null）", async () => {
  const ws = await makeWorkspace("session-list-down");
  try {
    const t = createThread(ws, { agentId: "life", title: "只有库" });
    recordTurn(ws, { threadId: t.id, userContent: "x" });
    const client = {
      threads: {
        search: async () => {
          throw new Error("platform down");
        },
      },
    } as never;
    const items = await listWorkspaceSessions(ws, { client });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.liveStatus, null);
  } finally {
    await dropWorkspace(ws);
  }
});

// —— 补充：库侧压缩 / 冷会话重放窗口 / 保留期 / 检索 ——

/** 造 n 轮对话（每轮：用户“第 i 轮” + 助手“答 i”） */
function seedTurns(ws: string, threadId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    recordTurn(ws, {
      threadId,
      userContent: `第${i}轮`,
      messages: [{ role: "ai", kind: "text", content: `答${i}` }],
    });
  }
}

test("compactThread：按轮次压缩，保留最近 N 轮，摘要覆盖被移出窗口的轮次", async () => {
  const ws = await makeWorkspace("compact-basic");
  try {
    const t = createThread(ws, { agentId: "life", title: "压缩" });
    seedTurns(ws, t.id, 5);
    const record = compactThread(ws, t.id, { keepRecentTurns: 2 });
    assert.ok(record);
    assert.equal(record!.compactedTurnCount, 3);
    assert.equal(record!.keptFromIdx, 3);
    assert.deepEqual(
      listTurns(ws, t.id).map((turn) => turn.compactedBy === null),
      [false, false, false, true, true],
    );
    assert.equal(readCompaction(ws, t.id)?.id, record!.id);
    assert.match(record!.summary, /第0轮/);
    assert.match(record!.summary, /答0/);
    assert.match(record!.summary, /第2轮/);
    assert.doesNotMatch(record!.summary, /第3轮/); // 窗口内的不进摘要
  } finally {
    await dropWorkspace(ws);
  }
});

test("compactThreadIfNeeded：未压缩轮次未超阈值不压缩，超过才压缩（可关）", async () => {
  const ws = await makeWorkspace("compact-threshold");
  try {
    const t = createThread(ws, { agentId: "life" });
    const config = { enabled: true, afterTurns: 5, keepRecentTurns: 2, summaryMaxChars: 4000 };
    seedTurns(ws, t.id, 3);
    assert.equal(compactThreadIfNeeded(ws, t.id, config), null);
    seedTurns(ws, t.id, 3);
    const record = compactThreadIfNeeded(ws, t.id, config);
    assert.ok(record); // 未压缩 6 > 5
    assert.equal(listTurns(ws, t.id).filter((turn) => turn.compactedBy === null).length, 2);
    // 关闭后不再压缩
    assert.equal(compactThreadIfNeeded(ws, t.id, { ...config, enabled: false }), null);
  } finally {
    await dropWorkspace(ws);
  }
});

test("buildReplayContext：摘要 + 窗口内轮次消息（被压缩的只以摘要存在）", async () => {
  const ws = await makeWorkspace("compact-replay");
  try {
    const t = createThread(ws, { agentId: "life" });
    seedTurns(ws, t.id, 4);
    compactThread(ws, t.id, { keepRecentTurns: 2 });
    const context = buildReplayContext(ws, t.id);
    assert.ok(context.summary);
    assert.deepEqual(context.turns.map((turn) => turn.idx), [2, 3]);
    assert.equal(
      context.turns[0]!.messages.find((m) => m.role === "human")!.content,
      "第2轮",
    );
  } finally {
    await dropWorkspace(ws);
  }
});

test("压缩不静默丢失：被压缩轮次的消息仍可检索", async () => {
  const ws = await makeWorkspace("compact-search");
  try {
    const t = createThread(ws, { agentId: "life" });
    seedTurns(ws, t.id, 4);
    compactThread(ws, t.id, { keepRecentTurns: 1 });
    const hits = searchThreadMessages(ws, t.id, "第0轮");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.content, "第0轮");
  } finally {
    await dropWorkspace(ws);
  }
});

test("pruneThreadHistory：只清超出保留期限的轮次（<=0 不清理）", async () => {
  const ws = await makeWorkspace("prune-retention");
  try {
    const t = createThread(ws, { agentId: "life" });
    recordTurn(ws, {
      threadId: t.id,
      userContent: "old",
      endedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    recordTurn(ws, { threadId: t.id, userContent: "new", endedAt: new Date().toISOString() });
    assert.equal(pruneThreadHistory(ws, t.id, { retentionDays: 7 }), 1);
    assert.deepEqual(readThreadMessages(ws, t.id).map((m) => m.content), ["new"]);
    assert.equal(pruneThreadHistory(ws, t.id, { retentionDays: 0 }), 0);
  } finally {
    await dropWorkspace(ws);
  }
});

test("resolveCompactionConfig：阈值可配置，OPEN_ASSISTANT_COMPACT=0 关闭", () => {
  assert.equal(resolveCompactionConfig({} as NodeJS.ProcessEnv).afterTurns, 20);
  const config = resolveCompactionConfig({
    OPEN_ASSISTANT_COMPACT: "0",
    OPEN_ASSISTANT_COMPACT_AFTER_TURNS: "3",
    OPEN_ASSISTANT_COMPACT_KEEP_TURNS: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.equal(config.afterTurns, 3);
  assert.equal(config.keepRecentTurns, 1);
});

test("recordTurnToWorkspace：按配置自动压缩（落库路径触发）", async () => {
  const ws = await makeWorkspace("record-auto-compact");
  try {
    const compaction = { enabled: true, afterTurns: 2, keepRecentTurns: 1, summaryMaxChars: 4000 };
    for (let i = 0; i < 4; i++) {
      recordTurnToWorkspace(ws, {
        threadId: "t-auto",
        agentId: "life",
        messages: [new HumanMessage({ id: `h${i}`, content: `u${i}` }), new AIMessage(`a${i}`)],
        compaction,
      });
    }
    assert.ok(readCompaction(ws, "t-auto"));
    // afterTurns=2：第 3 轮触发一次（保留 1），第 4 轮后又累积到 2（未超阈值）
    assert.equal(listTurns(ws, "t-auto").filter((turn) => turn.compactedBy === null).length, 2);
  } finally {
    await dropWorkspace(ws);
  }
});

test("会话名称 CRUD：默认标题 → 改名 → 清空", async () => {
  const ws = await makeWorkspace("rename-title");
  try {
    const t = createThread(ws, { agentId: "life", title: null });
    recordTurn(ws, { threadId: t.id, userContent: "原始首条输入" });
    assert.equal(getThread(ws, t.id)!.title, "原始首条输入");
    updateThreadTitle(ws, t.id, "改过的名字");
    assert.equal(getThread(ws, t.id)!.title, "改过的名字");
    // 清空 → 回到 null（列表显示占位标题）
    updateThreadTitle(ws, t.id, null);
    assert.equal(getThread(ws, t.id)!.title, null);
  } finally {
    await dropWorkspace(ws);
  }
});