/**
 * 频道运行时逻辑测试（tasks 13.10 / 13.11 / 13.15 / 13.16 / 13.18 / 13.19）。
 *
 * 这些都是**纯逻辑**（去重 / 退避 / 看门狗 / 会话键 / 入站归一化 / 出站整形 / 访问控制），
 * 不碰网络，所以能完整测。它们正是「平台会重放事件」「同会话不能并发」
 * 「纯媒体不能被挂起」「陌生人要被看见」这些真实故障的防线。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  BoundedDedupe,
  ExponentialBackoff,
  SilentConnectionWatchdog,
  approveSender,
  channelAccessPath,
  decideNoTextDebounce,
  debounceKeyFor,
  denySender,
  dismissPending,
  isFatalCloseCode,
  isSenderAllowed,
  normalizeContentParts,
  parseSessionKey,
  pendingCount,
  readChannelAccess,
  recordPendingSender,
  renderPartsForModel,
  senderState,
  sessionKeyFor,
  shapeOutbound,
  shouldSend,
  truncateWithMarker,
  type ContentPart,
} from "../src/channels/index.js";

let root = "";
let counter = 0;
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oa-chrt-")));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function freshAgent(name: string): Promise<string> {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("13.10 有界去重（平台会重放事件）", () => {
  test("首次 true，重复 false", () => {
    const d = new BoundedDedupe();
    expect(d.first("evt-1")).toBe(true);
    expect(d.first("evt-1")).toBe(false);
    expect(d.first("evt-2")).toBe(true);
  });

  test("容量满时淘汰最旧的，不会无限膨胀", () => {
    const d = new BoundedDedupe({ capacity: 3 });
    for (const id of ["a", "b", "c", "d"]) d.first(id);
    expect(d.size).toBe(3);
    expect(d.has("a")).toBe(false); // 最旧的被淘汰
    expect(d.has("d")).toBe(true);
  });

  test("超 TTL 后同一 id 视为新事件", () => {
    let now = 1000;
    const d = new BoundedDedupe({ ttlMs: 100, now: () => now });
    expect(d.first("x")).toBe(true);
    now += 50;
    expect(d.first("x")).toBe(false);
    now += 200;
    expect(d.first("x")).toBe(true);
  });

  test("空 id 一律放行（无法去重时宁可重复也不丢消息）", () => {
    const d = new BoundedDedupe();
    expect(d.first("")).toBe(true);
    expect(d.first("")).toBe(true);
    expect(d.first(null)).toBe(true);
    expect(d.first(undefined)).toBe(true);
  });

  test("重复出现会刷新位置，避免热门事件被先淘汰", () => {
    const d = new BoundedDedupe({ capacity: 2 });
    d.first("hot");
    d.first("cold");
    d.first("hot"); // 刷新
    d.first("new"); // 挤掉最旧的 —— 应该是 cold
    expect(d.has("hot")).toBe(true);
    expect(d.has("cold")).toBe(false);
  });
});

describe("13.11 退避重连与静默看门狗", () => {
  test("指数增长并封顶", () => {
    const b = new ExponentialBackoff({ baseMs: 100, maxMs: 1000, jitterRatio: 0 });
    expect(b.nextDelayMs()).toBe(100);
    expect(b.nextDelayMs()).toBe(200);
    expect(b.nextDelayMs()).toBe(400);
    expect(b.nextDelayMs()).toBe(800);
    expect(b.nextDelayMs()).toBe(1000); // 封顶
    expect(b.nextDelayMs()).toBe(1000);
  });

  test("连上后 reset，下次从头退避", () => {
    const b = new ExponentialBackoff({ baseMs: 100, jitterRatio: 0 });
    b.nextDelayMs();
    b.nextDelayMs();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
    expect(b.nextDelayMs()).toBe(100);
  });

  test("抖动落在 ±比例内，且不会为负", () => {
    const b = new ExponentialBackoff({ baseMs: 1000, maxMs: 1000, jitterRatio: 0.2, random: () => 0 });
    expect(b.nextDelayMs()).toBe(800);
    const b2 = new ExponentialBackoff({ baseMs: 1000, maxMs: 1000, jitterRatio: 0.2, random: () => 1 });
    expect(b2.nextDelayMs()).toBe(1200);
  });

  test("看门狗：有数据就不触发，静默超时才触发一次", () => {
    let now = 0;
    const fired: number[] = [];
    const w = new SilentConnectionWatchdog((idle) => fired.push(idle), {
      idleMs: 100,
      checkIntervalMs: 10,
      now: () => now,
      setInterval: () => 0,
      clearInterval: () => {},
    });

    now = 50;
    w.touch();
    now = 120;
    expect(w.check()).toBe(false); // 距上次 touch 只过了 70

    now = 200;
    expect(w.check()).toBe(true); // 过了 150 > 100
    expect(fired).toEqual([150]);

    // 触发后不会立刻二次触发（内部已重置基准）
    expect(w.check()).toBe(false);
  });

  test("start/stop 幂等，不重复注册定时器", () => {
    let registered = 0;
    let cleared = 0;
    const w = new SilentConnectionWatchdog(() => {}, {
      now: () => 0,
      setInterval: () => {
        registered += 1;
        return registered;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });
    w.start();
    w.start();
    expect(registered).toBe(1);
    w.stop();
    w.stop();
    expect(cleared).toBe(1);
  });

  test("需要按断开处理的关闭码", () => {
    expect(isFatalCloseCode(1006)).toBe(true);
    expect(isFatalCloseCode(4004)).toBe(true);
    expect(isFatalCloseCode(1000)).toBe(false);
    expect(isFatalCloseCode(null)).toBe(false);
  });
});

describe("13.15 会话键与去抖键同源", () => {
  test("私聊与群聊一定是不同键", () => {
    const dm = sessionKeyFor({ channel: "qq", account: "1024", peer: "u1", isDirect: true });
    const grp = sessionKeyFor({ channel: "qq", account: "1024", peer: "u1", isDirect: false });
    expect(dm).not.toBe(grp);
    expect(dm).toBe("qq:1024:dm:u1");
    expect(grp).toBe("qq:1024:ch:u1");
  });

  test("不同频道 / 不同账号不共用会话", () => {
    const a = sessionKeyFor({ channel: "qq", account: "1", peer: "p" });
    const b = sessionKeyFor({ channel: "feishu", account: "1", peer: "p" });
    const c = sessionKeyFor({ channel: "qq", account: "2", peer: "p" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("去抖键与会话键严格同源（否则同会话会并发）", () => {
    const input = { channel: "feishu", account: "cli_x", peer: "oc_1", isDirect: false };
    expect(debounceKeyFor(input)).toBe(sessionKeyFor(input));
  });

  test("段里的分隔符与空白被清洗，不会注入出多余层级", () => {
    const key = sessionKeyFor({ channel: "qq", account: " a b ", peer: "p:q" });
    expect(parseSessionKey(key)?.peer).toBe("p-q");
    expect(key.split(":")).toHaveLength(4);
  });

  test("能解析回各部分；格式不对返回 null", () => {
    expect(parseSessionKey("qq:1:dm:u")?.scope).toBe("dm");
    expect(parseSessionKey("bad")).toBeNull();
  });
});

describe("13.16 入站归一化与无文本去抖", () => {
  test("有文本：立刻放行，并带上此前缓存的片段（图先到配文后到）", () => {
    const pending: ContentPart[] = [{ kind: "image", url: "http://x/1.png" }];
    const res = decideNoTextDebounce(pending, [{ kind: "text", text: "这是什么" }]);
    expect(res.flush).toBe(true);
    expect(res.parts).toHaveLength(2);
  });

  test("无文本但是语音：立刻放行（语音本身是完整输入）", () => {
    const res = decideNoTextDebounce([], [{ kind: "audio", url: "http://x/v.mp3" }]);
    expect(res.flush).toBe(true);
  });

  test("无文本且非语音：缓存，本次不处理", () => {
    const res = decideNoTextDebounce([], [{ kind: "image", url: "http://x/1.png" }]);
    expect(res.flush).toBe(false);
    expect(res.parts).toEqual([]);
  });

  test("缓存里的图 + 后面的语音也能合并且放行", () => {
    const res = decideNoTextDebounce([{ kind: "image", url: "a.png" }], [{ kind: "audio", url: "v.mp3" }]);
    expect(res.flush).toBe(true);
    expect(res.parts).toHaveLength(2);
  });

  test("归一化：区分文本/媒体/语音", () => {
    const n = normalizeContentParts([
      { kind: "text", text: "  " },
      { kind: "image", url: "a" },
      { kind: "audio", url: "b" },
    ]);
    expect(n.hasText).toBe(false);
    expect(n.hasMedia).toBe(true);
    expect(n.hasAudio).toBe(true);
  });

  test("渲染给模型时附件用占位符（缺地址也不炸）", () => {
    const n = normalizeContentParts([{ kind: "text", text: "看这个" }, { kind: "image" }]);
    expect(renderPartsForModel(n)).toContain("看这个");
    expect(renderPartsForModel(n)).toContain("[图片:");
  });
});

describe("13.18 出站回复整形", () => {
  const call = { name: "todo_create", args: "内容=买牛奶", result: "已创建" };

  test("默认把思考藏起来、工具调用与结果显示出来", () => {
    const out = shapeOutbound({ text: "好了", thinking: "内部推理", toolCalls: [call], config: {} });
    expect(out).not.toContain("内部推理");
    expect(out).toContain("🔧 todo_create");
    expect(out).toContain("已创建");
    expect(out).toContain("好了");
  });

  test("打开 show_thinking 才出现思考", () => {
    const out = shapeOutbound({ text: "好了", thinking: "内部推理", config: { show_thinking: true } });
    expect(out).toContain("内部推理");
  });

  test("关掉工具调用与结果 → 一个都不出现", () => {
    const out = shapeOutbound({
      text: "好了",
      toolCalls: [call],
      config: { show_tool_calls: false, show_tool_results: false },
    });
    expect(out).not.toContain("todo_create");
    expect(out).not.toContain("已创建");
    expect(out).toBe("好了");
  });

  test("回复前缀加在最前面", () => {
    const out = shapeOutbound({ text: "好了", config: { bot_prefix: "小助：" } });
    expect(out).toBe("小助：\n好了");
  });

  test("长度上限生效且留可见标记", () => {
    const long = "x".repeat(2000);
    const out = shapeOutbound({
      text: "ok",
      toolCalls: [{ name: "t", result: long }],
      config: { tool_result_max_length: 100, show_tool_results: true },
    });
    expect(out).toContain("已截断");
    expect(out).not.toContain("x".repeat(500));
    expect(truncateWithMarker("abcdef", 3)).toBe("abc…（已截断 3 字）");
    expect(truncateWithMarker("ab", 3)).toBe("ab");
  });

  test("全空则不值得发（避免留下空气泡）", () => {
    expect(shouldSend(shapeOutbound({ text: "", thinking: "只想了没答", config: {} }))).toBe(false);
    expect(shouldSend(shapeOutbound({ text: "有内容", config: {} }))).toBe(true);
    expect(shouldSend(shapeOutbound({ text: "", config: { bot_prefix: "小助：" } }))).toBe(true);
  });
});

describe("13.19 访问控制：陌生人挂起待审批", () => {
  test("陌生人被记入待审批，且幂等（重复尝试只加计数）", async () => {
    const dir = await freshAgent("acl-pending");
    await recordPendingSender(dir, "qq", { id: "u1", displayName: "小明" }, "2026-10-01T10:00:00Z");
    await recordPendingSender(dir, "qq", { id: "u1" }, "2026-10-01T10:05:00Z");
    const entry = await readChannelAccess(dir, "qq");
    expect(entry.pending).toHaveLength(1);
    expect(entry.pending[0]!.attempts).toBe(2);
    expect(entry.pending[0]!.firstSeenAt).toBe("2026-10-01T10:00:00Z");
    expect(entry.pending[0]!.lastSeenAt).toBe("2026-10-01T10:05:00Z");
    expect(pendingCount(entry)).toBe(1);
    expect(senderState(entry, "u1")).toBe("pending");
  });

  test("批准：进允许名单并从待审批移除", async () => {
    const dir = await freshAgent("acl-approve");
    await recordPendingSender(dir, "qq", { id: "u1" });
    await approveSender(dir, "qq", "u1");
    const entry = await readChannelAccess(dir, "qq");
    expect(entry.allow).toEqual(["u1"]);
    expect(entry.pending).toEqual([]);
    expect(senderState(entry, "u1")).toBe("allow");
  });

  test("拒绝：进拒绝名单并从允许与待审批移除（互斥不变式）", async () => {
    const dir = await freshAgent("acl-deny");
    await approveSender(dir, "qq", "u1");
    await recordPendingSender(dir, "qq", { id: "u1" });
    await denySender(dir, "qq", "u1");
    const entry = await readChannelAccess(dir, "qq");
    expect(entry.deny).toEqual(["u1"]);
    expect(entry.allow).toEqual([]);
    expect(entry.pending).toEqual([]);
    expect(senderState(entry, "u1")).toBe("deny");
  });

  test("已允许/已拒绝的人不再被挂起", async () => {
    const dir = await freshAgent("acl-nowait");
    await approveSender(dir, "qq", "u1");
    await denySender(dir, "qq", "u2");
    await recordPendingSender(dir, "qq", { id: "u1" });
    await recordPendingSender(dir, "qq", { id: "u2" });
    expect((await readChannelAccess(dir, "qq")).pending).toEqual([]);
  });

  test("只移除待审批（先不管）", async () => {
    const dir = await freshAgent("acl-dismiss");
    await recordPendingSender(dir, "qq", { id: "u1" });
    await dismissPending(dir, "qq", "u1");
    const entry = await readChannelAccess(dir, "qq");
    expect(entry.pending).toEqual([]);
    expect(entry.allow).toEqual([]);
    expect(senderState(entry, "u1")).toBe("unknown");
  });

  test("准入判定：open 放行，allowlist 只放名单内", async () => {
    const dir = await freshAgent("acl-gate");
    await approveSender(dir, "qq", "u1");
    const entry = await readChannelAccess(dir, "qq");
    expect(isSenderAllowed(entry, "u1", "allowlist")).toBe(true);
    expect(isSenderAllowed(entry, "stranger", "allowlist")).toBe(false);
    expect(isSenderAllowed(entry, "stranger", "open")).toBe(true);
  });

  test("名单按频道隔离，且落在 agent 目录里（与频道配置同处）", async () => {
    const dir = await freshAgent("acl-scope");
    await approveSender(dir, "qq", "u1");
    expect((await readChannelAccess(dir, "feishu")).allow).toEqual([]);
    expect(channelAccessPath(dir)).toBe(path.join(dir, "channel-access.json"));
    expect(await fs.stat(channelAccessPath(dir)).then((s) => s.isFile())).toBe(true);
  });

  test("文件损坏时按空名单处理，不阻断频道工作", async () => {
    const dir = await freshAgent("acl-corrupt");
    await fs.writeFile(channelAccessPath(dir), "{ broken", "utf8");
    expect(await readChannelAccess(dir, "qq")).toEqual({ allow: [], deny: [], pending: [] });
  });
});