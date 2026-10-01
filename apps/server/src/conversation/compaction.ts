/**
 * 会话压缩（**库侧**）——以「轮次」为单位，把较早的轮次标为已压缩并生成一个确定性摘要，
 * 让「会话重开时按窗口重放（摘要 + 最近若干轮）」成立；被压缩内容仍留在库中可检索。
 *
 * ## 与 deepagents 的分工
 *
 * 热会话的**实时上下文**压缩由 `deepagents` 的 `summarizationMiddleware` 负责（改的是
 * 发给模型的那一份 messages）。这里负责的是会话**记录**的压缩：
 * - 冷会话重开时能从库按窗口重放（design D3 的「压缩 = 控制重放窗口」）
 * - 平台/库里的历史不会无限增长，但**不静默丢失**（消息仍在，可检索）
 *
 * ## 摘要为什么是确定性的
 *
 * 不调用模型：压缩本身必须在任何时刻、可离线、可测试地跑。摘要是对被移出窗口的轮次
 * 做确定性归并（用户输入 + 助手文本）。要更高质量的摘要时，模型可在重放时再加工。
 */
import crypto from "node:crypto";

import {
  getThread,
  listTurns,
  pruneTurnsBefore,
  readTurnMessages,
  setTurnCompactedBy,
  updateThread,
} from "./store.js";
import type { MessageRecord, TurnRecord } from "./types.js";

/** 压缩配置（阈值 / 保留窗口 / 摘要上限）；`enabled=false` 时完全不压缩 */
export interface CompactionConfig {
  enabled: boolean;
  /** 未压缩轮次数超过它才触发压缩 */
  afterTurns: number;
  /** 压缩后保留的最近轮次数 */
  keepRecentTurns: number;
  /** 摘要文本上限（字符），超出截断 */
  summaryMaxChars: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  afterTurns: 20,
  keepRecentTurns: 8,
  summaryMaxChars: 4000,
};

/** 压缩记录（存在会话 `meta_json.compaction`） */
export interface CompactionRecord {
  id: string;
  at: string;
  /** 被压缩到的最大轮次序号 */
  compactedThroughIdx: number;
  /** 摘要覆盖的轮次数（含此前已压缩的，重复压缩时递增） */
  compactedTurnCount: number;
  /** 窗口起点轮次序号（保留的第一轮）；没有可保留轮次时为 null */
  keptFromIdx: number | null;
  summary: string;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 从环境变量解析压缩配置（阈值可配置；`OPEN_ASSISTANT_COMPACT=0` 关闭） */
export function resolveCompactionConfig(env: NodeJS.ProcessEnv = process.env): CompactionConfig {
  return {
    enabled: env["OPEN_ASSISTANT_COMPACT"] !== "0",
    afterTurns: positiveInt(env["OPEN_ASSISTANT_COMPACT_AFTER_TURNS"], DEFAULT_COMPACTION_CONFIG.afterTurns),
    keepRecentTurns: positiveInt(
      env["OPEN_ASSISTANT_COMPACT_KEEP_TURNS"],
      DEFAULT_COMPACTION_CONFIG.keepRecentTurns,
    ),
    summaryMaxChars: positiveInt(
      env["OPEN_ASSISTANT_COMPACT_SUMMARY_CHARS"],
      DEFAULT_COMPACTION_CONFIG.summaryMaxChars,
    ),
  };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 由被移出窗口的轮次生成确定性摘要（用户输入 + 助手文本） */
function buildSummary(
  workspaceDir: string,
  threadId: string,
  turns: TurnRecord[],
  maxChars: number,
): string {
  const lines: string[] = [`（以下为已压缩的更早对话，共 ${turns.length} 轮）`];
  for (const turn of turns) {
    const messages = readTurnMessages(workspaceDir, threadId, turn.idx);
    lines.push(`#${turn.idx} 用户：${oneLine(turn.userContent, 200)}`);
    const aiText = messages
      .filter((m: MessageRecord) => m.role === "ai" && m.kind === "text" && m.content)
      .map((m: MessageRecord) => m.content as string)
      .join(" ");
    if (aiText.length > 0) lines.push(`#${turn.idx} 助手：${oneLine(aiText, 300)}`);
  }
  return truncate(lines.join("\n"), maxChars);
}

/** 读取会话的压缩记录（没有则 null） */
export function readCompaction(workspaceDir: string, threadId: string): CompactionRecord | null {
  const thread = getThread(workspaceDir, threadId);
  const raw = thread?.meta?.["compaction"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["summary"] !== "string") return null;
  return {
    id: record["id"],
    at: typeof record["at"] === "string" ? record["at"] : "",
    compactedThroughIdx: Number(record["compactedThroughIdx"] ?? 0),
    compactedTurnCount: Number(record["compactedTurnCount"] ?? 0),
    keptFromIdx:
      record["keptFromIdx"] === null || record["keptFromIdx"] === undefined
        ? null
        : Number(record["keptFromIdx"]),
    summary: record["summary"],
  };
}

/**
 * 压缩某会话：把最早的轮次标记为已压缩（`compacted_by`），保留最近 `keepRecentTurns` 轮，
 * 并把覆盖到的全部轮次重建成一份摘要写进会话 `meta_json.compaction`。
 * 轮次不足（≤ keepRecentTurns）时返回 null。
 */
export function compactThread(
  workspaceDir: string,
  threadId: string,
  options: { keepRecentTurns: number; summaryMaxChars?: number },
): CompactionRecord | null {
  const keep = Math.max(0, Math.floor(options.keepRecentTurns));
  const turns = listTurns(workspaceDir, threadId);
  if (turns.length <= keep) return null;

  const keptFrom = turns[turns.length - keep];
  const throughIdx = turns[turns.length - keep - 1]!.idx;
  // 摘要覆盖「到目前为止被移出窗口的全部轮次」（含此前已压缩的），重复压缩时摘要延续
  const covered = turns.filter((turn) => turn.idx <= throughIdx);
  const record: CompactionRecord = {
    id: `cmp_${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    compactedThroughIdx: throughIdx,
    compactedTurnCount: covered.length,
    keptFromIdx: keptFrom?.idx ?? null,
    summary: buildSummary(
      workspaceDir,
      threadId,
      covered,
      options.summaryMaxChars ?? DEFAULT_COMPACTION_CONFIG.summaryMaxChars,
    ),
  };
  for (const turn of covered) setTurnCompactedBy(workspaceDir, turn.id, record.id);
  updateThread(workspaceDir, threadId, { metaPatch: { compaction: record } });
  return record;
}

/**
 * 按阈值触发压缩：**未压缩轮次数**超过 `afterTurns` 时，保留最近 `keepRecentTurns` 轮并压缩其余。
 * 返回压缩记录；未触发返回 null。
 */
export function compactThreadIfNeeded(
  workspaceDir: string,
  threadId: string,
  config: CompactionConfig = resolveCompactionConfig(),
): CompactionRecord | null {
  if (!config.enabled) return null;
  const uncompacted = listTurns(workspaceDir, threadId).filter((turn) => turn.compactedBy === null);
  if (uncompacted.length <= config.afterTurns) return null;
  return compactThread(workspaceDir, threadId, {
    keepRecentTurns: config.keepRecentTurns,
    summaryMaxChars: config.summaryMaxChars,
  });
}

export interface ReplayTurn {
  idx: number;
  userContent: string;
  messages: MessageRecord[];
}

export interface ReplayContext {
  /** 被压缩部分的摘要（没有压缩则 null） */
  summary: string | null;
  /** 重放窗口：未压缩的最近轮次（含各自消息），按轮次序号升序 */
  turns: ReplayTurn[];
  compaction: CompactionRecord | null;
}

/**
 * 构造冷会话重放上下文：`摘要 + 窗口内轮次的消息`。
 * 冷会话重开时用它起一条新线程，窗口之外的轮次只以摘要形式存在（原文仍在库中可检索）。
 */
export function buildReplayContext(
  workspaceDir: string,
  threadId: string,
  options: { keepRecentTurns?: number } = {},
): ReplayContext {
  const compaction = readCompaction(workspaceDir, threadId);
  const all = listTurns(workspaceDir, threadId);
  // 窗口 = 未压缩的轮次；没有压缩记录时就是全部轮次
  let windowTurns = compaction ? all.filter((turn) => turn.compactedBy === null) : all;
  if (options.keepRecentTurns !== undefined && options.keepRecentTurns >= 0) {
    windowTurns = windowTurns.slice(Math.max(0, windowTurns.length - options.keepRecentTurns));
  }
  return {
    summary: compaction?.summary ?? null,
    compaction,
    turns: windowTurns.map((turn) => ({
      idx: turn.idx,
      userContent: turn.userContent,
      messages: readTurnMessages(workspaceDir, threadId, turn.idx),
    })),
  };
}

/**
 * 按保留期限清理：删除结束时间早于 `retentionDays` 天的轮次（含消息）。
 * `retentionDays <= 0` 表示不清理。返回删除的轮次数。
 */
export function pruneThreadHistory(
  workspaceDir: string,
  threadId: string,
  options: { retentionDays: number; now?: Date },
): number {
  const days = Math.max(0, Math.floor(options.retentionDays));
  if (days <= 0) return 0;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return pruneTurnsBefore(workspaceDir, threadId, cutoff);
}