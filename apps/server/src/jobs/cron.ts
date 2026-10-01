/**
 * cron 表达式解析 / 归一化（对齐 specs/agent-scheduling「周期规则含时区」与
 * 任务说明里保留自 QwenPaw `app/crons/models.py` 的校验规则）。
 *
 * 保留的规则：
 * - 只接受 5 / 4 / 3 段；**拒绝 6 段（秒）**。
 *   - 5 段：`min hour dom month dow`
 *   - 4 段：按 `hour dom month dow` 归一化成 `0 <hour> <dom> <month> <dow>`
 *   - 3 段：按 `dom month dow` 归一化成 `0 0 <dom> <month> <dow>`
 * - day-of-week 歧义：crontab 的 `0=周日` 与部分调度库的 `0=周一` 不一致，
 *   因此在校验期把数字 DOW 归一化成 `mon`…`sun` 缩写（0 与 7 都映射到 sun）。
 * - 用 cron-parser 做最终语法/取值校验，并用 IANA 时区计算下一次触发时刻。
 */
import { CronExpressionParser } from "cron-parser";
import { JobError } from "./types.js";

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 归一化后的 cron：`fields` 始终是 5 段 */
export interface NormalizedCron {
  /** 归一化后的表达式（5 段，DOW 已转缩写） */
  expression: string;
  fields: [string, string, string, string, string];
  /** 是否发生了变化（4/3 段补位，或数字 DOW 转缩写） */
  changed: boolean;
}

function isNumericField(value: string): boolean {
  return /^\d+$/.test(value);
}

function normalizeDowToken(token: string): string {
  // `*` 与 `*/n`（从 0 起计数）保持原样：展开成名字会改变步进语义。
  if (token === "*" || token.startsWith("*/")) return token;

  const slash = token.indexOf("/");
  const rangePart = slash >= 0 ? token.slice(0, slash) : token;
  const step = slash >= 0 ? token.slice(slash) : "";

  if (rangePart === "*") return token;

  const dash = rangePart.indexOf("-");
  if (dash >= 0) {
    const startRaw = rangePart.slice(0, dash);
    const endRaw = rangePart.slice(dash + 1);
    const start = Number(startRaw);
    const end = Number(endRaw);
    // 两端都是数字：按 crontab 语义展开成明确的星期缩写列表（0/7 = sun）。
    if (isNumericField(startRaw) && isNumericField(endRaw) && start <= end && end <= 7) {
      const names: string[] = [];
      for (let day = start; day <= end; day += 1) {
        const name = DOW_NAMES[day % 7]!;
        if (!names.includes(name)) names.push(name);
      }
      return names.join(",") + step;
    }
    // 缩写 / 混合端点：只把数字端点转缩写
    const convert = (raw: string): string => {
      if (!isNumericField(raw)) return raw.toLowerCase();
      return DOW_NAMES[Number(raw) % 7]!;
    };
    return `${convert(startRaw)}-${convert(endRaw)}${step}`;
  }

  // 单点（可带步进）：`5` / `5/2`
  if (isNumericField(rangePart)) {
    return DOW_NAMES[Number(rangePart) % 7]! + step;
  }
  return rangePart.toLowerCase() + step;
}

function normalizeDowField(field: string): string {
  return field
    .split(",")
    .map((token) => normalizeDowToken(token.trim()))
    .filter((token) => token.length > 0)
    .join(",");
}

/**
 * 校验并归一化 cron 表达式。
 * 非法（段数、语法、取值、秒级）→ 抛 JobError(JOB_INVALID_CRON)。
 */
export function normalizeCronExpression(raw: unknown): NormalizedCron {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new JobError("JOB_INVALID_CRON", "周期任务必须提供 cron 表达式");
  }
  const parts = raw.trim().split(/\s+/);
  let fields: string[];
  let changedSegments = false;
  if (parts.length === 6) {
    throw new JobError(
      "JOB_INVALID_CRON",
      `不支持 6 段（秒级）cron：${JSON.stringify(raw)}；请用 5 段 \`分 时 日 月 周\``,
    );
  } else if (parts.length === 5) {
    fields = parts;
  } else if (parts.length === 4) {
    // 4 段 = hour dom month dow → 补 min=0
    fields = ["0", ...parts];
    changedSegments = true;
  } else if (parts.length === 3) {
    // 3 段 = dom month dow → 补 min/hour=0
    fields = ["0", "0", ...parts];
    changedSegments = true;
  } else {
    throw new JobError(
      "JOB_INVALID_CRON",
      `cron 段数非法（只接受 5 / 4 / 3 段，收到 ${parts.length} 段）：${JSON.stringify(raw)}`,
    );
  }

  const dowNormalized = normalizeDowField(fields[4]!);
  const normalized: [string, string, string, string, string] = [
    fields[0]!,
    fields[1]!,
    fields[2]!,
    fields[3]!,
    dowNormalized,
  ];
  const expression = normalized.join(" ");
  const changed = changedSegments || expression !== raw.trim().replace(/\s+/g, " ");

  try {
    CronExpressionParser.parse(expression);
  } catch (err) {
    throw new JobError(
      "JOB_INVALID_CRON",
      `cron 表达式非法：${JSON.stringify(raw)}（${(err as Error).message}）`,
    );
  }
  return { expression, fields: normalized, changed };
}

/** 纯校验便捷函数：返回归一化后的表达式 */
export function validateCron(raw: unknown): string {
  return normalizeCronExpression(raw).expression;
}

/** 校验 IANA 时区是否可用（非法 → 抛 JobError） */
export function validateTimezone(timezone: unknown): string | undefined {
  if (timezone === undefined || timezone === null || timezone === "") return undefined;
  if (typeof timezone !== "string") {
    throw new JobError("JOB_INVALID_INPUT", "schedule.timezone 必须是字符串");
  }
  try {
    // Intl 会校验 IANA 名称；同时被 cron-parser / luxon 使用
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new JobError("JOB_INVALID_INPUT", `时区非法：${JSON.stringify(timezone)}`);
  }
  return timezone;
}

/**
 * 计算下一次触发时刻；没有下一次（如不可能日期）→ null。
 * `from` 为基准时刻（默认当前），`timezone` 缺省按本地时区。
 */
export function cronNext(cron: string, timezone: string | undefined, from: Date): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, {
      currentDate: from,
      ...(timezone ? { tz: timezone } : {}),
    });
    if (!it.hasNext()) return null;
    return it.next().toDate();
  } catch {
    return null;
  }
}