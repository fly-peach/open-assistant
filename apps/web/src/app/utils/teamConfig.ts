/**
 * 团队页的纯函数（表单草稿 ↔ 请求载荷、标识校验、工具目录 → 勾选行）。
 *
 * 为什么单独抽出来：本仓前端**没有 jsdom / 没有 fetch 打桩先例**，
 * 页面级交互测不了；所以把「容易写错又必须对」的逻辑放这里单测，
 * UI 只做薄壳（与 `utils/agentConfig.ts`、`lib/jobsApi.ts` 的分工一致）。
 *
 * 三条最容易写错的语义在这里被固定下来：
 * 1. `tools: null`（未声明 = 继承主 agent）**不等于** `tools: []`（一个工具都不给）；
 * 2. 模型留空 = **不写 `model` 键**（沿用主 agent 的解析链），不是写 `null` 进配置；
 * 3. 标识校验只做前端可读提示，**权威判定在后端**。
 */
import zh from "@/i18n/zh";
import type { AgentConfig } from "@/lib/agentsApi";
import type {
  SubAgentMember,
  SubAgentModel,
  SubAgentPatch,
  ToolCatalogGroup,
} from "@/lib/teamApi";
import {
  modelPayload,
  modelSelectValue,
  validateAgentId,
  type AgentIdError,
} from "@/app/utils/agentConfig";

/**
 * Radix Select 不接受空字符串 value，所以「沿用主 agent 的模型」用这个哨兵值表示，
 * 提交前再换回空串（空串 → 不写 `model` 键）。
 * 与 `/agents/[id]` 的 `INHERIT_MODEL` 同名同形，但语义不同：
 * 那边是「跟随全局默认」（会显式写进 config.json），这边是「不写这个键」。
 */
export const INHERIT_MODEL = "__inherit__";

/** 工具白名单的两种模式：未声明（继承）/ 自定义清单。 */
export type ToolsMode = "inherit" | "custom";

/** 单个成员卡片上的表单草稿（全是字符串，输入框的自然形态）。 */
export interface MemberDraft {
  description: string;
  /** 正文 = 该子 agent 的系统提示词。 */
  systemPrompt: string;
  toolsMode: ToolsMode;
  /** 自定义模式下勾选的工具名；继承模式下不参与提交。 */
  tools: string[];
  /** Select 的当前值：`INHERIT_MODEL` 表示不写 `model` 键。 */
  model: string;
}

/* ------------------------------------------------------------ 成员 → 草稿 */

/** 该成员是否「未声明 tools」（继承主 agent 已开启的工具组）。 */
export function inheritToolsMode(member: SubAgentMember): boolean {
  return member.tools === null;
}

/** 草稿里要勾选的工具名：`null` → 空数组（继承模式下本来也不渲染勾选）。 */
export function toolSelectionFrom(member: SubAgentMember): string[] {
  return member.tools ?? [];
}

/** 成员 → 表单草稿。`model` 为空时落到 `INHERIT_MODEL` 哨兵（不是空串）。 */
export function memberDraftFrom(member: SubAgentMember): MemberDraft {
  const selectValue = modelSelectValue({ model: member.model } as AgentConfig);
  return {
    description: member.description,
    systemPrompt: member.systemPrompt,
    toolsMode: inheritToolsMode(member) ? "inherit" : "custom",
    tools: toolSelectionFrom(member),
    model: selectValue || INHERIT_MODEL,
  };
}

/* ------------------------------------------------------------ 草稿 → 载荷 */

/** 哨兵 → 空串（空串表示「不写 model 键」）。 */
export function parseModelValue(raw: string): string {
  return raw === INHERIT_MODEL ? "" : raw.trim();
}

/** 工具名去重、保序、丢空串（勾选顺序即用户操作顺序，不重排）。 */
export function normalizeToolSelection(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** 草稿里的模型 → 提交用的声明（留空 → `null` = 删掉 frontmatter 的 model 键）。 */
export function draftModelPayload(raw: string): SubAgentModel | null {
  const value = parseModelValue(raw);
  return value ? modelPayload(value, null) : null;
}

/**
 * 草稿 → `PUT /agents/{id}/team/{name}` 的载荷。
 *
 * 三个字段**总是**一起提交（description / tools / model），正文也一起写：
 * `SPEC.md` 是一个文件，一次 PUT 就是一次原子写，
 * 不会出现「frontmatter 已改、正文还是旧的」的中间态。
 * 校验失败时后端整份拒绝，文件一个字节都不动。
 */
export function memberPayload(draft: MemberDraft): SubAgentPatch {
  return {
    description: draft.description.trim(),
    tools: draft.toolsMode === "inherit" ? null : normalizeToolSelection(draft.tools),
    model: draftModelPayload(draft.model),
    systemPrompt: draft.systemPrompt,
  };
}

/** 草稿是否有未保存改动（纯函数，供卡片显示「有未保存的改动」与 `data-*`）。 */
export function draftsEqual(left: MemberDraft, right: MemberDraft): boolean {
  return (
    left.description === right.description &&
    left.systemPrompt === right.systemPrompt &&
    left.model === right.model &&
    left.toolsMode === right.toolsMode &&
    (left.toolsMode === "inherit" ||
      normalizeToolSelection(left.tools).join("\u0000") ===
        normalizeToolSelection(right.tools).join("\u0000"))
  );
}

/* ------------------------------------------------------------ 工具目录 */

export interface ToolOption {
  name: string;
  checked: boolean;
}

export interface ToolRowGroup {
  group: string;
  /** 主 agent 是否开着这个工具组（关掉时勾了也不生效）。 */
  enabled: boolean;
  tools: ToolOption[];
}

/**
 * 工具目录 + 当前勾选 → 可直接渲染的分组行。
 *
 * `unknown` 是「清单里没有、但声明里写着」的工具名：**保留但标出来**，
 * 不静默丢掉（对齐 `toolOptions` 的「已知 ∪ 配置里出现的其他取值」）。
 * 后端对未知工具名会 400 拒绝，前端只负责让用户看见它。
 */
export function buildToolRows(
  catalog: readonly ToolCatalogGroup[],
  selected: readonly string[]
): { groups: ToolRowGroup[]; unknown: string[] } {
  const chosen = new Set(normalizeToolSelection(selected));
  const known = new Set<string>();
  const groups = catalog.map((group) => ({
    group: group.group,
    enabled: group.enabled,
    tools: group.tools.map((name) => {
      known.add(name);
      return { name, checked: chosen.has(name) };
    }),
  }));
  const unknown = normalizeToolSelection(selected).filter((name) => !known.has(name));
  return { groups, unknown };
}

/** 勾选 / 取消勾选（保序：新勾选的追加在末尾，取消则移除）。 */
export function toggleToolSelection(
  selected: readonly string[],
  name: string
): string[] {
  const list = normalizeToolSelection(selected);
  return list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
}

/** 工具组的显示名：已知组走 i18n，未知组原样显示（不编造）。 */
export function toolGroupLabel(group: string): string {
  return (zh.agents.toolGroup as Record<string, string>)[group] ?? group;
}

/* ------------------------------------------------------------ 标识与排序 */

/** 目录名校验错误的可读文案（复用 `/agents` 新建表单的同一批文案）。 */
export function subAgentIdErrorText(reason: AgentIdError): string | null {
  if (!reason) return null;
  switch (reason) {
    case "empty":
      return zh.agents.idErrorEmpty;
    case "separator":
      return zh.agents.idErrorSeparator;
    case "dotdot":
      return zh.agents.idErrorDotDot;
    case "whitespace":
      return zh.agents.idErrorWhitespace;
    default:
      return zh.agents.idErrorCharset;
  }
}

/** 新建子 agent 的目录名校验（前端先挡一层，后端还会再判一次）。 */
export function validateSubAgentName(raw: string): AgentIdError {
  return validateAgentId(raw);
}

/**
 * 成员按目录名排序（稳定，便于断言与阅读）。
 * 非法成员**照样在列表里**，只是排在同样的位置规则下。
 */
export function sortMembers(members: readonly SubAgentMember[]): SubAgentMember[] {
  return [...members].sort((left, right) => left.name.localeCompare(right.name));
}

/** 后端给出的已知 issue 码 → 界面文案；未知码原样显示后端文案（不吞掉信息）。 */
const ISSUE_CODE_LABEL: Record<string, string> = {
  MISSING_DESCRIPTION: zh.team.noDescription,
  NAME_MISMATCH: zh.team.nameMismatch,
  INVALID_YAML: zh.team.yamlBroken,
  YAML_INVALID: zh.team.yamlBroken,
};

/** 一条 issue 的可读文案：已知码前面补一句摘要，其余只用后端原文。 */
export function issueLabel(issue: { code: string; message: string }): string {
  const label = ISSUE_CODE_LABEL[issue.code];
  return label ? `${label} · ${issue.message}` : issue.message;
}

/** 非法声明的原因合并成一行（多个 issue 用「；」分隔）。 */
export function issuesText(issues: readonly { code: string; message: string }[]): string {
  return issues.map(issueLabel).join("；");
}
