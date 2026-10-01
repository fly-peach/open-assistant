/**
 * 频道访问控制（task 13.19）。
 *
 * ## 核心设计：陌生人**挂起**而不是拒绝
 *
 * QwenPaw 的做法值得照搬：未在名单内的来源不是静默丢弃，而是
 * **记入待审批 + 回一条带自己标识的提示**，等管理员在频道页里裁决。
 * 理由很实际 —— 静默拒绝会让用户以为「机器人坏了」，而挂起能让管理员**看见**有人被挡在外面。
 *
 * ## 一个不变式：名单互斥
 *
 * 一个来源在任一时刻**只能出现在三处之一**：允许 / 拒绝 / 待审批。
 * 所有变更都要维持这条；否则会出现「既在允许名单又在拒绝名单」这种自相矛盾的状态，
 * 行为取决于代码里先查哪个列表 —— 典型的难查 bug。
 *
 * 存放：`<agents 根>/<agent-id>/channel-access.json`（与频道配置同处，归属 agent）。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { writeJsonAtomic } from "../agents/json-file.js";

export const CHANNEL_ACCESS_FILE = "channel-access.json";

/** 单个来源的裁决状态 */
export type SenderState = "allow" | "deny" | "pending" | "unknown";

export interface PendingSender {
  id: string;
  /** 展示用名字（平台给的昵称之类） */
  displayName?: string;
  /** 首次被挂起的时间 */
  firstSeenAt: string;
  /** 最近一次尝试联系的时间 */
  lastSeenAt: string;
  /** 尝试次数（去重后的） */
  attempts: number;
}

export interface ChannelAccessEntry {
  allow: string[];
  deny: string[];
  pending: PendingSender[];
}

export interface ChannelAccessFile {
  version: 1;
  updatedAt: string;
  /** 频道键 → 该频道的名单 */
  channels: Record<string, ChannelAccessEntry>;
}

function emptyEntry(): ChannelAccessEntry {
  return { allow: [], deny: [], pending: [] };
}

function emptyFile(now = new Date().toISOString()): ChannelAccessFile {
  return { version: 1, updatedAt: now, channels: {} };
}

export function channelAccessPath(agentDir: string): string {
  return path.join(path.resolve(agentDir), CHANNEL_ACCESS_FILE);
}

/** 读名单文件；不存在/损坏 → 空（名单是附加策略，坏了不该阻断频道工作） */
export async function readAccessFile(agentDir: string): Promise<ChannelAccessFile> {
  try {
    const raw = await fs.readFile(channelAccessPath(agentDir), "utf8");
    const parsed = JSON.parse(raw) as ChannelAccessFile;
    if (parsed && typeof parsed === "object" && parsed.channels && typeof parsed.channels === "object") {
      return parsed;
    }
  } catch {
    /* 空 */
  }
  return emptyFile();
}

async function writeAccessFile(agentDir: string, file: ChannelAccessFile): Promise<void> {
  await fs.mkdir(path.resolve(agentDir), { recursive: true });
  await writeJsonAtomic(channelAccessPath(agentDir), { ...file, version: 1 });
}

export async function readChannelAccess(
  agentDir: string,
  channelKey: string,
): Promise<ChannelAccessEntry> {
  const file = await readAccessFile(agentDir);
  const entry = file.channels[channelKey];
  if (!entry) return emptyEntry();
  return {
    allow: [...(entry.allow ?? [])],
    deny: [...(entry.deny ?? [])],
    pending: (entry.pending ?? []).map((p) => ({ ...p })),
  };
}

function normalizeEntry(entry: ChannelAccessEntry): ChannelAccessEntry {
  const allow = [...new Set(entry.allow.filter((s) => typeof s === "string" && s.length > 0))];
  const deny = [...new Set(entry.deny.filter((s) => typeof s === "string" && s.length > 0))]
    // 互斥：允许优先（后写的人主动批准了，就该是允许）
    .filter((s) => !allow.includes(s));
  const pending = entry.pending.filter((p) => p && typeof p.id === "string" && p.id.length > 0)
    .filter((p) => !allow.includes(p.id) && !deny.includes(p.id));
  return { allow, deny, pending };
}

async function mutate(
  agentDir: string,
  channelKey: string,
  fn: (entry: ChannelAccessEntry) => ChannelAccessEntry,
): Promise<ChannelAccessEntry> {
  const file = await readAccessFile(agentDir);
  const current = file.channels[channelKey] ?? emptyEntry();
  const next = normalizeEntry(fn({ allow: [...current.allow], deny: [...current.deny], pending: current.pending.map((p) => ({ ...p })) }));
  file.channels[channelKey] = next;
  file.updatedAt = new Date().toISOString();
  await writeAccessFile(agentDir, file);
  return next;
}

/** 某个来源当前的裁决状态 */
export function senderState(entry: ChannelAccessEntry, senderId: string): SenderState {
  if (entry.allow.includes(senderId)) return "allow";
  if (entry.deny.includes(senderId)) return "deny";
  if (entry.pending.some((p) => p.id === senderId)) return "pending";
  return "unknown";
}

/**
 * 记录一次来自陌生人的尝试：**幂等**（已在待审批里就只更新计数与时间，不重复插入）。
 * 若该来源已允许/已拒绝，则不改动（调用方应先判状态）。
 */
export async function recordPendingSender(
  agentDir: string,
  channelKey: string,
  sender: { id: string; displayName?: string },
  now = new Date().toISOString(),
): Promise<ChannelAccessEntry> {
  return mutate(agentDir, channelKey, (entry) => {
    if (entry.allow.includes(sender.id) || entry.deny.includes(sender.id)) return entry;
    const existing = entry.pending.find((p) => p.id === sender.id);
    if (existing) {
      existing.lastSeenAt = now;
      existing.attempts += 1;
      if (sender.displayName) existing.displayName = sender.displayName;
    } else {
      entry.pending.push({
        id: sender.id,
        ...(sender.displayName ? { displayName: sender.displayName } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
        attempts: 1,
      });
    }
    return entry;
  });
}

/** 批准：进允许名单，并从拒绝与待审批中移除（维持互斥） */
export async function approveSender(
  agentDir: string,
  channelKey: string,
  senderId: string,
): Promise<ChannelAccessEntry> {
  return mutate(agentDir, channelKey, (entry) => {
    if (!entry.allow.includes(senderId)) entry.allow.push(senderId);
    entry.deny = entry.deny.filter((s) => s !== senderId);
    entry.pending = entry.pending.filter((p) => p.id !== senderId);
    return entry;
  });
}

/** 拒绝：进拒绝名单，并从允许与待审批中移除 */
export async function denySender(
  agentDir: string,
  channelKey: string,
  senderId: string,
): Promise<ChannelAccessEntry> {
  return mutate(agentDir, channelKey, (entry) => {
    if (!entry.deny.includes(senderId)) entry.deny.push(senderId);
    entry.allow = entry.allow.filter((s) => s !== senderId);
    entry.pending = entry.pending.filter((p) => p.id !== senderId);
    return entry;
  });
}

/** 只从待审批里移除（例如用户想「先不管」） */
export async function dismissPending(
  agentDir: string,
  channelKey: string,
  senderId: string,
): Promise<ChannelAccessEntry> {
  return mutate(agentDir, channelKey, (entry) => {
    entry.pending = entry.pending.filter((p) => p.id !== senderId);
    return entry;
  });
}

/**
 * 准入判定。
 *
 * ⚠️ 必须用**真实发送者**的 id，而不是被共享的会话标识 —— 群内共享会话时
 * 若用会话 id 判定，全群都会被当成同一个人（对齐 specs/channels「准入以真实发送者为准」）。
 *
 * `policy === "open"` 时不看名单；`"allowlist"` 时只有允许名单内的来源通过。
 */
export function isSenderAllowed(
  entry: ChannelAccessEntry,
  senderId: string,
  policy: "open" | "allowlist",
): boolean {
  if (policy === "open") return true;
  return entry.allow.includes(senderId);
}

/** 待审批数量（界面徽标用） */
export function pendingCount(entry: ChannelAccessEntry): number {
  return entry.pending.length;
}