/**
 * 会话键与去抖键（tasks 13.14 / 13.15）。
 *
 * ## 为什么两个键必须由同一个函数算出来
 *
 * QwenPaw 的队列管理器注释里点明过这件事：**入队路由 key 与去抖 key 必须同源**，
 * 否则会出现「去抖按 A 分组、排队按 B 分组」—— 两个消息被判为不同会话而**并发**跑，
 * 于是两轮同时写同一份会话状态。这是最难查的一类竞态。
 *
 * ## 键的形状
 * `频道:账号:对端`：账号来自频道配置（同一个人可能有多个机器人），对端是群里/私聊的对象。
 * 把账号编进去，避免「同一个群里两个机器人共用会话」。
 */

export interface SessionKeyInput {
  /** 频道键，如 `qq` / `feishu` */
  channel: string;
  /** 账号标识：优先用平台侧的应用标识，缺失时退化为空段 */
  account?: string | null;
  /** 对端标识：群聊用群 id，私聊用对方 id */
  peer: string;
  /** 私聊标记（同一个人既可能私聊也可能在群里，两者要分开） */
  isDirect?: boolean;
}

/** 清洗一段：去掉分隔符与空白，避免键被注入出多余层级 */
function segment(value: string | null | undefined, fallback: string): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[\s:]+/g, "-");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 生成会话键。
 * 私聊与群聊**一定不同键**（`dm` / `ch` 前缀区分），否则同一个人在两处的上下文会串。
 */
export function sessionKeyFor(input: SessionKeyInput): string {
  const channel = segment(input.channel, "unknown");
  const account = segment(input.account, "-");
  const scope = input.isDirect ? "dm" : "ch";
  const peer = segment(input.peer, "unknown");
  return `${channel}:${account}:${scope}:${peer}`;
}

/**
 * 去抖键 —— **与 {@link sessionKeyFor} 严格同源**，保证「同会话串行」。
 * 单独抽成函数只是为了让调用点显式说明用途，实现必须是同一个键。
 */
export function debounceKeyFor(input: SessionKeyInput): string {
  return sessionKeyFor(input);
}

/** 从会话键里取回各部分（调试与界面展示用） */
export function parseSessionKey(
  key: string,
): { channel: string; account: string; scope: string; peer: string } | null {
  const parts = String(key ?? "").split(":");
  if (parts.length !== 4) return null;
  const [channel, account, scope, peer] = parts as [string, string, string, string];
  return { channel, account, scope, peer };
}