import { describe, expect, test } from "bun:test";

import type { WorkspaceSession } from "@/lib/sessionsApi";
import { sessionThreadStatus, sessionToThreadItem } from "@/app/utils/sessionView";

function makeSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: "t1",
    agentId: "life",
    kind: "main",
    title: "待办",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    turnCount: 1,
    messageCount: 2,
    unfinishedTurnCount: 0,
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    liveStatus: null,
    ...overrides,
  };
}

describe("sessionThreadStatus：记录 + 实时状态取舍", () => {
  test("热会话的实时状态优先（busy / interrupted 不丢）", () => {
    expect(sessionThreadStatus(makeSession({ liveStatus: "busy" }))).toBe("busy");
    expect(sessionThreadStatus(makeSession({ liveStatus: "interrupted", status: "error" }))).toBe(
      "interrupted"
    );
  });

  test("无实时状态时：记录 error → error，有未结束轮次 → interrupted，否则 idle", () => {
    expect(sessionThreadStatus(makeSession({ status: "error" }))).toBe("error");
    expect(sessionThreadStatus(makeSession({ unfinishedTurnCount: 1 }))).toBe("interrupted");
    expect(sessionThreadStatus(makeSession())).toBe("idle");
  });
});

describe("sessionToThreadItem：字段映射", () => {
  test("有标题用标题，无标题用占位；时间转 Date；带 agentId", () => {
    const item = sessionToThreadItem(makeSession(), "未命名会话");
    expect(item.id).toBe("t1");
    expect(item.title).toBe("待办");
    expect(item.agentId).toBe("life");
    expect(item.updatedAt).toBeInstanceOf(Date);
    expect(item.updatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  test("title 为 null / 空串 → 占位标题", () => {
    expect(sessionToThreadItem(makeSession({ title: null }), "未命名会话").title).toBe(
      "未命名会话"
    );
    expect(sessionToThreadItem(makeSession({ title: "" }), "未命名会话").title).toBe(
      "未命名会话"
    );
  });
});