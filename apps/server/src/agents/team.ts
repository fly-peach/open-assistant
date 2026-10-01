/**
 * 子 agent 团队：`<agents 根>/<agent-id>/team/<子 agent 名>/SPEC.md` 的扫描 / 解析 / 校验 / 编辑。
 *
 * 对齐 `specs/subagent-team`（验收标准）与 `spike/findings/04-team-page.md` §3.1/§3.2。
 *
 * ## 数据模型
 *
 * ```
 * <agents 根>/<agent-id>/team/<子 agent 名>/SPEC.md
 *   ---                       ← YAML frontmatter（复用 wiki/frontmatter.ts 的解析）
 *   name: trainer             ← 必填，必须 == 目录名
 *   description: 训练计划与…   ← 必填，路由依据（主 agent 靠它决定派谁）
 *   tools: [read_file]        ← 可选；缺省（不写该键）= 继承主 agent 已开启的工具组
 *   model: {"id":"x"}         ← 可选；缺省 = 沿用主 agent 的解析链
 *   skills: [/skills/foo/]    ← 可选；缺省 = 空（子 agent 默认不继承主 agent 的技能）
 *   mode: isolated            ← 可选，默认 isolated
 *   ---
 *   正文 = 该子 agent 的**完整** systemPrompt
 * ```
 *
 * ## 三条硬约束（每条都有测试）
 *
 * 1. **单个声明非法不得拖垮整体加载**：解析**不抛错**，非法项进 `members` 并带 `valid:false` + `issues`
 *    （与 `registry.ts` 的 `collectIssues` 同一范式）。
 * 2. **保存非法内容被拒绝且不破坏原文件**：写盘前先「合并 → 渲染 → 回读校验」，
 *    校验不过直接抛错，**一个字节都不写**；写盘用 tmp + rename 原子写。
 * 3. **`mode` 自己校验**：只接受 `isolated` / `fork`。底层 deepagents 会**静默放行** `handoff`
 *    并让它行为等同 `isolated`（`spike/findings/01-delegation.md` §1.4），本模块不继承该行为。
 *
 * ## 与运行时的分工
 *
 * 本模块**只产数据**（`SubAgentMember`），不 import deepagents：
 * - 「数据 → deepagents `SubAgent` 描述符」（工具实例 / 模型 / 中间件）在 `src/agent.ts` 里做；
 * - 「工具白名单 + 工具组开关 + 结构性防递归」的**名字层**解析在本模块
 *   （`resolveSubAgentToolNames`，纯函数、可单测），实例化由 `agent.ts` 完成。
 */
import path from "node:path";
import fs from "node:fs/promises";

import { AgentError } from "./errors.js";
import {
  AGENT_TEAM_DIR,
  AGENT_TEAM_SPEC_FILE,
  agentDirPath,
  teamDirPath,
} from "./root.js";
import { isValidAgentId, readAgentConfig } from "./registry.js";
import { statOrNull, writeTextAtomic } from "./json-file.js";
import {
  frontmatterBlock,
  parseFrontmatter,
  renderFrontmatter,
  type FrontmatterValue,
} from "../wiki/frontmatter.js";
import {
  type AgentConfig,
  TOOL_GROUPS,
  TOOL_GROUP_NAMES,
  type ToolGroup,
  defaultAgentConfig,
  toolGroupOf,
} from "./config.js";

// —— 常量 ——

/** 底层 deepagents **总是**注入的通用子 agent 名（本产品没有关闭入口，见 spec「内置通用子 agent 的处置」） */
export const GENERAL_PURPOSE_SUBAGENT_NAME = "general-purpose";

/** 运行时内置成员：用户 MUST NOT 用同名目录去定义它们 */
export const BUILTIN_SUBAGENT_NAMES: readonly string[] = [GENERAL_PURPOSE_SUBAGENT_NAME];

/** 合法 `mode` 取值（`handoff` 是底层静默放行的幽灵值，这里必须拒绝） */
export const SUBAGENT_MODES = ["isolated", "fork"] as const;
export type SubAgentMode = (typeof SUBAGENT_MODES)[number];

/**
 * 文件中间件额外提供、但不在 `TOOL_GROUPS.files` 清单里的工具。
 * 只用于「已知工具名」与「工具组归属」的判定，**不进 `toolCatalog`**（前端契约不变）。
 */
const EXTRA_FILESYSTEM_TOOLS: readonly string[] = ["delete"];

/** 已知工具名（工具组清单 + 文件中间件额外工具）。不在其中的名字一律视为非法声明 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  ...TOOL_GROUP_NAMES.flatMap((group) => [...TOOL_GROUPS[group]]),
  ...EXTRA_FILESYSTEM_TOOLS,
];

/**
 * 子 agent **永远**拿不到的工具：委派 / 跨工作区调用 / 同侪互通。
 * 结构性防递归 —— 即使 SPEC.md 里写了也不给（对齐 spec「子 agent 不继承委派工具」）。
 */
export const SUBAGENT_FORBIDDEN_TOOL_NAMES: readonly string[] = [
  ...TOOL_GROUPS.delegation,
  ...TOOL_GROUPS.crossAgent,
  ...TOOL_GROUPS.peers,
];

/** 工具名 → 所属工具组（含文件中间件的额外工具）；不属于任何已知组 → null */
export function toolGroupOfName(toolName: string): ToolGroup | null {
  if (EXTRA_FILESYSTEM_TOOLS.includes(toolName)) return "files";
  return toolGroupOf(toolName);
}

// —— 类型 ——

/** 单条声明问题（「标注而非失败」范式，对齐 registry 的 collectIssues） */
export interface SubAgentIssue {
  code: string;
  message: string;
}

export interface SubAgentModelRef {
  id: string;
  providerId?: string;
}

export interface SubAgentMember {
  /** 子 agent 标识（= 目录名） */
  name: string;
  /** 该子 agent 的目录绝对路径 */
  dir: string;
  /** `SPEC.md` 的绝对路径 */
  specPath: string;
  /** 声明是否合法：false 的成员不会进入运行时团队 */
  valid: boolean;
  issues: SubAgentIssue[];
  /** 路由描述；未解析出来时为 "" */
  description: string;
  /** 工具白名单；null = 未声明（继承主 agent 已开启的工具组） */
  tools: string[] | null;
  model: SubAgentModelRef | null;
  /** 技能源路径；null = 未声明（空技能） */
  skills: string[] | null;
  mode: SubAgentMode;
  /** 正文 = 该子 agent 的完整 systemPrompt（完全替换 deepagents 内置提示词） */
  systemPrompt: string;
}

/** 工具目录（供前端渲染「按组多选」，`enabled` 只有后端知道） */
export interface ToolCatalogGroup {
  group: string;
  enabled: boolean;
  tools: string[];
}

/** 运行时内置成员（deepagents 注入、关不掉；显式列出以免隐式存在） */
export interface BuiltinSubAgent {
  name: string;
  builtin: true;
  description: string;
  /** 该内置成员使用主 agent 的模型与全部已开启工具 */
  note: string;
}

export interface TeamView {
  agentId: string;
  dir: string;
  teamDir: string;
  exists: boolean;
  members: SubAgentMember[];
  toolCatalog: ToolCatalogGroup[];
  /** 契约之外的**附加**字段：运行时内置成员（前端可忽略） */
  builtins: BuiltinSubAgent[];
}

/** 单个 SPEC.md 的位置 */
export interface SubAgentLocation {
  dir: string;
  specPath: string;
}

// —— 标识校验 ——

/**
 * 合法子 agent 标识：复用 agent 标识规则（非空 / ≤64 / 无空白 / 无路径分隔符 / 无 `..` / 不以 `.` 开头）。
 * 目录名就是标识，所以这些字符会直接影响文件系统布局，必须在入口拒绝。
 */
export function isValidSubAgentId(id: unknown): id is string {
  return isValidAgentId(id);
}

export function assertValidSubAgentId(id: unknown): asserts id is string {
  if (!isValidSubAgentId(id)) {
    throw new AgentError(
      "SUBAGENT_INVALID_ID",
      `非法子 agent 标识 ${JSON.stringify(id)}：不能为空、不能含空白 / 路径分隔符 / ".." / 冒号等特殊字符，长度不超过 64`,
      400,
      "name",
    );
  }
}

/** 标识是否与运行时内置成员冲突（`general-purpose`） */
export function isBuiltinSubAgentName(id: string): boolean {
  return BUILTIN_SUBAGENT_NAMES.includes(id);
}

function assertNotBuiltinName(id: string, action: "新建" | "装载"): void {
  if (!isBuiltinSubAgentName(id)) return;
  throw new AgentError(
    "SUBAGENT_INVALID_ID",
    `不能${action}名为 ${JSON.stringify(id)} 的子 agent：它与运行时内置成员冲突` +
      `（deepagents 总是注入该成员，使用主 agent 的模型与全部工具）。请换一个名字。`,
    400,
    "name",
  );
}

// —— 纯函数：解析 ——

function issue(code: string, message: string): SubAgentIssue {
  return { code, message };
}

/** frontmatter 里出现、但我们不认识的键：保留（写回时原样带回），不算错 */
const MANAGED_KEYS = ["name", "description", "tools", "model", "skills", "mode"] as const;

/**
 * 元数据区里是否有「语法上无法解析」的行（`wiki/frontmatter.ts` 的解析器是容错的，会静默跳过）。
 * 判定规则：非空、非注释、非 `键: 值`、非 `- 列表项` 的行即视为坏行。
 */
function findUnparsableLine(block: string): number | null {
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^-\s+/.test(trimmed)) continue;
    if (/^[A-Za-z0-9_.-]+\s*:/.test(trimmed)) continue;
    return i + 1;
  }
  return null;
}

/**
 * 解析 `model` 字段：接受
 * - `{"id":"x","providerId":"y"}`（JSON）
 * - `{id: x, providerId: y}`（YAML flow map，用户手写时的自然形态）
 * - `x`（裸字符串 = 模型 id）
 */
function parseModelValue(raw: FrontmatterValue | undefined): { value: SubAgentModelRef | null; issue?: SubAgentIssue } {
  if (raw === undefined) return { value: null };
  if (Array.isArray(raw)) {
    return { value: null, issue: issue("INVALID_MODEL", "model 必须是对象或字符串，不能是列表") };
  }
  const text = raw.trim();
  if (text === "" || text === "{}" || text === "null") return { value: null };
  if (!text.startsWith("{")) return { value: { id: text } };

  const inner = text.slice(1, text.endsWith("}") ? -1 : undefined).trim();
  const fields: Record<string, string> = {};
  for (const part of inner.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    const at = seg.indexOf(":");
    if (at < 0) {
      return { value: null, issue: issue("INVALID_MODEL", `model 无法解析：${JSON.stringify(text)}`) };
    }
    const key = seg.slice(0, at).trim().replace(/^["']|["']$/g, "");
    const value = seg.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }
  const id = (fields["id"] ?? "").trim();
  if (id === "") {
    return { value: null, issue: issue("INVALID_MODEL", `model 缺少 id：${JSON.stringify(text)}`) };
  }
  const providerId = (fields["providerId"] ?? "").trim();
  return { value: providerId === "" ? { id } : { id, providerId } };
}

/**
 * 解析一份 `SPEC.md`。**不抛错**：任何问题都进 `issues` 并把 `valid` 置 false
 * （对齐 spec「单个声明非法不得拖垮整个团队加载」）。
 */
export function parseSubAgentSpec(
  content: string,
  dirName: string,
  location: SubAgentLocation = { dir: "", specPath: "" },
): SubAgentMember {
  const issues: SubAgentIssue[] = [];
  const specPath = location.specPath || path.join(dirName, AGENT_TEAM_SPEC_FILE);
  const member: SubAgentMember = {
    name: dirName,
    dir: location.dir,
    specPath,
    valid: true,
    issues,
    description: "",
    tools: null,
    model: null,
    skills: null,
    mode: "isolated",
    systemPrompt: "",
  };

  if (!isValidSubAgentId(dirName)) {
    issues.push(
      issue(
        "INVALID_ID",
        `目录名 ${JSON.stringify(dirName)} 不是合法的子 agent 标识（不能含空白 / 路径分隔符 / ".." / 冒号等），路径 ${specPath}`,
      ),
    );
  } else if (isBuiltinSubAgentName(dirName)) {
    issues.push(
      issue(
        "RESERVED_NAME",
        `子 agent 名 ${JSON.stringify(dirName)} 与运行时内置成员冲突（deepagents 总是注入它），路径 ${specPath}`,
      ),
    );
  }

  const fm = parseFrontmatter(content);
  if (!fm.ok) {
    issues.push(
      issue("INVALID_FRONTMATTER", `声明文件的元数据无法解析：缺少以 --- 包裹的元数据区，路径 ${specPath}`),
    );
    member.valid = false;
    return member;
  }
  const block = frontmatterBlock(content);
  const badLine = block === null ? null : findUnparsableLine(block);
  if (badLine !== null) {
    issues.push(
      issue("INVALID_FRONTMATTER", `声明文件的元数据无法解析：第 ${badLine} 行不是合法的「键: 值」，路径 ${specPath}`),
    );
  }

  member.systemPrompt = fm.body;
  member.description = "";

  // name
  const rawName = fm.data["name"];
  if (rawName === undefined || (typeof rawName === "string" && rawName.trim() === "")) {
    issues.push(issue("MISSING_NAME", `缺少子 agent 标识（name），路径 ${specPath}`));
  } else if (Array.isArray(rawName)) {
    issues.push(issue("MISSING_NAME", `name 必须是字符串，不能是列表，路径 ${specPath}`));
  } else if (rawName.trim() !== dirName) {
    issues.push(
      issue(
        "NAME_MISMATCH",
        `name 与目录名不一致：name=${JSON.stringify(rawName.trim())}，目录=${JSON.stringify(dirName)}，路径 ${specPath}`,
      ),
    );
  }

  // description（必填 = 路由依据）
  const rawDescription = fm.data["description"];
  if (rawDescription === undefined || Array.isArray(rawDescription) || rawDescription.trim() === "") {
    issues.push(
      issue("MISSING_DESCRIPTION", `缺少路由描述（description），路径 ${specPath}`),
    );
  } else {
    member.description = rawDescription.trim();
  }

  // tools（缺省 = null = 继承）
  const rawTools = fm.data["tools"];
  if (rawTools !== undefined) {
    const list = Array.isArray(rawTools) ? rawTools : rawTools.trim() === "" ? [] : [rawTools.trim()];
    const unknown = list.filter((name) => !KNOWN_TOOL_NAMES.includes(name));
    if (unknown.length > 0) {
      issues.push(
        issue(
          "INVALID_TOOLS",
          `tools 含未知工具名：${unknown.map((n) => JSON.stringify(n)).join("、")}；` +
            `可用工具名见工具组清单，路径 ${specPath}`,
        ),
      );
    }
    member.tools = [...new Set(list)];
  }

  // model（缺省 = null = 沿用主 agent 解析链）
  const parsedModel = parseModelValue(fm.data["model"]);
  if (parsedModel.issue) {
    issues.push(issue(parsedModel.issue.code, `${parsedModel.issue.message}，路径 ${specPath}`));
  } else {
    member.model = parsedModel.value;
  }

  // skills（缺省 = null = 空）
  const rawSkills = fm.data["skills"];
  if (rawSkills !== undefined) {
    const list = Array.isArray(rawSkills) ? rawSkills : rawSkills.trim() === "" ? [] : [rawSkills.trim()];
    member.skills = [...new Set(list.map((s) => s.trim()).filter((s) => s.length > 0))];
  }

  // mode（自己校验：底层会静默放行 handoff）
  const rawMode = fm.data["mode"];
  if (rawMode !== undefined && !Array.isArray(rawMode) && rawMode.trim() !== "") {
    const mode = rawMode.trim();
    if (!(SUBAGENT_MODES as readonly string[]).includes(mode)) {
      issues.push(
        issue(
          "INVALID_MODE",
          `mode 只能是 ${SUBAGENT_MODES.join(" / ")}（收到 ${JSON.stringify(mode)}），路径 ${specPath}`,
        ),
      );
    } else {
      member.mode = mode as SubAgentMode;
    }
  }

  member.valid = issues.length === 0;
  return member;
}

// —— 纯函数：渲染 ——

/** frontmatter 标量渲染：可能被误解析的值加引号（配合 stripQuotes 可无损回读） */
function renderScalar(value: string): string {
  if (value.length === 0) return '""';
  if (/^[[\]{}"']/.test(value) || /^[-?*&!|>%@`#]/.test(value) || value.endsWith(":")) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * 渲染一份 `SPEC.md`（frontmatter + 正文）。
 * - `previous` 里**不认识**的键原样保留（避免用户的额外元数据被吃掉）；
 * - `null` / `undefined` 的字段 = 不写该键（写回时即「删除该字段，回到继承默认」）。
 */
export function renderSubAgentSpec(
  member: Pick<SubAgentMember, "name" | "description" | "tools" | "model" | "skills" | "mode" | "systemPrompt">,
  previous?: string,
): string {
  const ordered: Record<string, FrontmatterValue> = {};
  if (previous !== undefined) {
    const prev = parseFrontmatter(previous);
    for (const [key, value] of Object.entries(prev.data)) {
      if ((MANAGED_KEYS as readonly string[]).includes(key)) continue;
      ordered[key] = value;
    }
    // 已知键按「规范顺序」排在前面，未知键保持在后
  }

  const fields: Record<string, FrontmatterValue | undefined> = {
    name: renderScalar(member.name),
    description: renderScalar(member.description),
    tools: member.tools === null ? undefined : member.tools,
    model: member.model === null ? undefined : JSON.stringify(member.model),
    skills: member.skills === null ? undefined : member.skills,
    mode: member.mode,
  };

  const merged: Record<string, FrontmatterValue> = {};
  for (const key of MANAGED_KEYS) {
    const value = fields[key];
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(ordered)) merged[key] = value;

  const body = member.systemPrompt.replace(/^\r?\n+/, "");
  return renderFrontmatter(merged) + body;
}

/** 新建子 agent 的骨架（不写 tools / model / skills —— 让它们保持「未声明 = 继承」） */
export function buildSpecSkeleton(name: string, description: string): string {
  return (
    renderFrontmatter({
      name: renderScalar(name),
      description: renderScalar(description),
      mode: "isolated",
    }) + "你是一个……（在此描述它的职责、边界与输出要求）\n"
  );
}

// —— 工具白名单解析（名字层，纯函数）——

/**
 * 算出该子 agent **实际可用**的工具名：
 * - `declared === null`（未声明）→ 继承主 agent **已开启**的工具组的全部工具；
 * - 委派 / 跨工作区 / 同侪工具**永不**下发（结构性防递归）；
 * - 主 agent 关掉的工具组，即使 SPEC.md 里列了也拿不到（spec「工具组开关对子 agent 生效」）。
 */
export function resolveSubAgentToolNames(declared: string[] | null, config: AgentConfig): string[] {
  const base =
    declared === null
      ? KNOWN_TOOL_NAMES.filter((name) => {
          const group = toolGroupOfName(name);
          return group === null ? true : config.tools[group] === true;
        })
      : declared;

  const out: string[] = [];
  for (const raw of base) {
    const name = raw.trim();
    if (name.length === 0 || out.includes(name)) continue;
    if (SUBAGENT_FORBIDDEN_TOOL_NAMES.includes(name)) continue;
    const group = toolGroupOfName(name);
    if (group !== null && config.tools[group] !== true) continue;
    out.push(name);
  }
  return out;
}

/** 工具目录（供前端按组渲染；`enabled` 跟随主 agent 的 config.tools） */
export function toolCatalog(config: AgentConfig): ToolCatalogGroup[] {
  return TOOL_GROUP_NAMES.map((group) => ({
    group,
    enabled: config.tools[group] === true,
    tools: [...TOOL_GROUPS[group]],
  }));
}

/** 运行时内置成员（显式列出，避免 `general-purpose` 隐式存在并与用户定义的子 agent 抢路由） */
export function builtinSubAgents(): BuiltinSubAgent[] {
  return [
    {
      name: GENERAL_PURPOSE_SUBAGENT_NAME,
      builtin: true,
      description:
        "通用子 agent（deepagents 运行时内置，无法关闭）：擅长检索文件与多步探索，用主 agent 的模型与全部已开启工具。",
      note:
        "它不是本产品声明的成员，也没有 SPEC.md；用户定义的子 agent 若描述覆盖同一场景，会与它竞争路由。" +
        `名为 ${GENERAL_PURPOSE_SUBAGENT_NAME} 的自定义子 agent 会被拒绝。`,
    },
  ];
}

// —— IO ——

async function assertAgentDir(agentId: unknown): Promise<string> {
  if (!isValidAgentId(agentId)) {
    throw new AgentError(
      "AGENT_INVALID_ID",
      `非法 agent 标识 ${JSON.stringify(agentId)}：不能为空、不能含空白 / 路径分隔符 / ".." / 冒号等特殊字符，长度不超过 64`,
      400,
      "id",
    );
  }
  const dir = agentDirPath(agentId);
  const st = await statOrNull(dir);
  if (!st?.isDirectory()) {
    throw new AgentError("AGENT_NOT_FOUND", `找不到 agent 定义：${agentId}（目录 ${dir}）`, 404, "id");
  }
  return dir;
}

/** 该 agent 的工具组配置；配置非法时退回默认（工具目录只是展示用，不该拖垮团队页） */
async function readToolConfig(agentId: string, dir: string): Promise<AgentConfig> {
  try {
    return await readAgentConfig(agentId, dir);
  } catch {
    return defaultAgentConfig({ id: agentId });
  }
}

/** 读取并解析一个子 agent 声明；文件缺失 → 标注非法（这不是错误，不影响其他成员） */
async function readMember(teamDir: string, name: string): Promise<SubAgentMember> {
  const specDir = path.join(teamDir, name);
  const specPath = path.join(specDir, AGENT_TEAM_SPEC_FILE);
  const st = await statOrNull(specPath);
  if (!st?.isFile()) {
    const member = parseSubAgentSpec("", name, { dir: specDir, specPath });
    member.valid = false;
    member.issues = [
      { code: "MISSING_SPEC_FILE", message: `缺少声明文件 ${AGENT_TEAM_SPEC_FILE}，路径 ${specPath}` },
    ];
    return member;
  }
  let content: string;
  try {
    content = await fs.readFile(specPath, "utf8");
  } catch (err) {
    const member = parseSubAgentSpec("", name, { dir: specDir, specPath });
    member.valid = false;
    member.issues = [
      { code: "UNREADABLE", message: `声明文件无法读取：${(err as Error).message}，路径 ${specPath}` },
    ];
    return member;
  }
  return parseSubAgentSpec(content, name, { dir: specDir, specPath });
}

/** 列出某个 agent 的团队成员（`team/` 不存在 → `{exists:false, members:[]}`，**不抛 404**） */
export async function listTeam(agentId: string): Promise<TeamView> {
  const dir = await assertAgentDir(agentId);
  const teamDir = teamDirPath(agentId);
  const config = await readToolConfig(agentId, dir);
  const base: TeamView = {
    agentId,
    dir,
    teamDir,
    exists: false,
    members: [],
    toolCatalog: toolCatalog(config),
    builtins: builtinSubAgents(),
  };

  const st = await statOrNull(teamDir);
  if (!st?.isDirectory()) return base;
  base.exists = true;

  const entries = await fs.readdir(teamDir, { withFileTypes: true });
  // 列出**所有**目录（含 `.` 开头的）：标识非法的目录也要以 valid:false 现身，
  // 悄悄吞掉用户的声明比显示一条「非法」更糟。
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    base.members.push(await readMember(teamDir, name));
  }
  return base;
}

/** 读取单个子 agent 的声明（不存在 → 404） */
export async function readSubAgent(agentId: string, name: unknown): Promise<SubAgentMember> {
  await assertAgentDir(agentId);
  assertValidSubAgentId(name);
  const specDir = path.join(teamDirPath(agentId), name);
  const specPath = path.join(specDir, AGENT_TEAM_SPEC_FILE);
  const st = await statOrNull(specPath);
  if (!st?.isFile()) {
    throw new AgentError(
      "SUBAGENT_NOT_FOUND",
      `找不到子 agent ${JSON.stringify(name)}（期望声明文件 ${specPath}）`,
      404,
      "name",
    );
  }
  return readMember(teamDirPath(agentId), name);
}

/** 问题码 → 非法字段（供 HTTP 出口给前端定位到具体输入框） */
const ISSUE_FIELD: Record<string, string> = {
  MISSING_DESCRIPTION: "description",
  MISSING_NAME: "name",
  NAME_MISMATCH: "name",
  INVALID_ID: "name",
  RESERVED_NAME: "name",
  INVALID_TOOLS: "tools",
  INVALID_MODEL: "model",
  INVALID_SKILLS: "skills",
  INVALID_MODE: "mode",
  INVALID_FRONTMATTER: "content",
  MISSING_SPEC_FILE: "content",
  UNREADABLE: "content",
};

function invalidSpecError(member: SubAgentMember): AgentError {
  const first = member.issues[0];
  const field = first ? ISSUE_FIELD[first.code] : undefined;
  const detail = member.issues.map((i) => i.message).join("；");
  return new AgentError(
    "SUBAGENT_INVALID_SPEC",
    `子 agent ${JSON.stringify(member.name)} 的声明非法：${detail}`,
    400,
    field,
  );
}

/** 校验「保存后」的内容：渲染 → 回读校验，任一问题即抛（保证写下去的文件一定可装载） */
function assertRenderedSpec(member: SubAgentMember, content: string): SubAgentMember {
  const check = parseSubAgentSpec(content, member.name, { dir: member.dir, specPath: member.specPath });
  if (!check.valid) throw invalidSpecError(check);
  return check;
}

export interface UpdateSubAgentInput {
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  skills?: unknown;
  mode?: unknown;
  systemPrompt?: unknown;
}

function asStringList(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentError("SUBAGENT_INVALID_SPEC", "该字段必须是字符串数组或 null", 400);
  }
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AgentError("SUBAGENT_INVALID_SPEC", "该字段必须是字符串数组或 null", 400);
    }
    const text = item.trim();
    if (text.length > 0 && !list.includes(text)) list.push(text);
  }
  return list;
}

/**
 * 更新一个子 agent：**合并 → 渲染 → 回读校验 → 原子写**。
 * 校验不过直接抛错，**一个字节都不写**（对齐 spec「保存被拒绝 … MUST NOT 破坏原有文件」）。
 *
 * 字段语义（对齐 §3.2）：字段缺席 = 不改；`tools` / `model` / `skills` 显式传 `null` = 删除该键（回到继承默认）。
 */
export async function updateSubAgent(
  agentId: string,
  name: unknown,
  patch: UpdateSubAgentInput,
): Promise<SubAgentMember> {
  await assertAgentDir(agentId);
  assertValidSubAgentId(name);
  const current = await readSubAgent(agentId, name);

  let description = current.description;
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") {
      throw new AgentError("SUBAGENT_INVALID_SPEC", "description 必须是字符串", 400, "description");
    }
    description = patch.description.trim();
  }
  if (description.length === 0) {
    throw new AgentError(
      "SUBAGENT_INVALID_SPEC",
      "缺少路由描述（description）：它是主 agent 路由的依据，不能为空",
      400,
      "description",
    );
  }
  if (/[\r\n]/.test(description)) {
    throw new AgentError(
      "SUBAGENT_INVALID_SPEC",
      "description 不能包含换行：它是单行元数据，多行说明请写进正文",
      400,
      "description",
    );
  }

  let tools = current.tools;
  if (patch.tools !== undefined) {
    const parsed = asStringList(patch.tools);
    tools = parsed === undefined ? current.tools : parsed;
  }

  let model = current.model;
  if (patch.model !== undefined) {
    if (patch.model === null) {
      model = null;
    } else if (typeof patch.model !== "object" || Array.isArray(patch.model)) {
      throw new AgentError("SUBAGENT_INVALID_SPEC", "model 必须是 { id, providerId? } 或 null", 400, "model");
    } else {
      const raw = patch.model as { id?: unknown; providerId?: unknown };
      if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
        throw new AgentError("SUBAGENT_INVALID_SPEC", "model.id 必须是非空字符串", 400, "model");
      }
      if (raw.providerId !== undefined && typeof raw.providerId !== "string") {
        throw new AgentError("SUBAGENT_INVALID_SPEC", "model.providerId 必须是字符串", 400, "model");
      }
      model =
        typeof raw.providerId === "string" && raw.providerId.trim().length > 0
          ? { id: raw.id.trim(), providerId: raw.providerId.trim() }
          : { id: raw.id.trim() };
    }
  }

  let skills = current.skills;
  if (patch.skills !== undefined) {
    const parsed = asStringList(patch.skills);
    skills = parsed === undefined ? current.skills : parsed;
  }

  let mode = current.mode;
  if (patch.mode !== undefined) {
    if (typeof patch.mode !== "string" || !(SUBAGENT_MODES as readonly string[]).includes(patch.mode)) {
      throw new AgentError(
        "SUBAGENT_INVALID_SPEC",
        `mode 只能是 ${SUBAGENT_MODES.join(" / ")}（收到 ${JSON.stringify(patch.mode)}）`,
        400,
        "mode",
      );
    }
    mode = patch.mode as SubAgentMode;
  }

  let systemPrompt = current.systemPrompt;
  if (patch.systemPrompt !== undefined) {
    if (typeof patch.systemPrompt !== "string") {
      throw new AgentError("SUBAGENT_INVALID_SPEC", "systemPrompt 必须是字符串", 400, "systemPrompt");
    }
    systemPrompt = patch.systemPrompt;
  }

  const next: SubAgentMember = {
    ...current,
    // 目录名就是标识：合并后一律以目录名为准（当前声明的 name 与目录名不一致时，
    // readSubAgent 已经把它作为 NAME_MISMATCH 报出来，这里不静默改写它）
    name,
    description,
    tools,
    model,
    skills,
    mode,
    systemPrompt,
    valid: true,
    issues: [],
  };

  const previous = await fs.readFile(current.specPath, "utf8");
  const rendered = renderSubAgentSpec(next, previous);
  const stored = assertRenderedSpec(next, rendered);
  await writeTextAtomic(current.specPath, rendered);
  return stored;
}

export interface CreateSubAgentInput {
  name: unknown;
  description?: unknown;
  systemPrompt?: unknown;
}

/** 新建子 agent（目录 + SPEC.md 骨架）。description 必填 —— 否则新建出来立刻就是非法成员 */
export async function createSubAgent(agentId: string, input: CreateSubAgentInput): Promise<string> {
  await assertAgentDir(agentId);
  const name = input.name;
  assertValidSubAgentId(name);
  assertNotBuiltinName(name, "新建");

  if (typeof input.description !== "string" || input.description.trim().length === 0) {
    throw new AgentError(
      "SUBAGENT_INVALID_SPEC",
      "缺少路由描述（description）：它是主 agent 路由的依据，不能为空",
      400,
      "description",
    );
  }
  const description = input.description.trim();
  if (/[\r\n]/.test(description)) {
    throw new AgentError(
      "SUBAGENT_INVALID_SPEC",
      "description 不能包含换行：它是单行元数据，多行说明请写进正文",
      400,
      "description",
    );
  }

  const specDir = path.join(teamDirPath(agentId), name);
  const specPath = path.join(specDir, AGENT_TEAM_SPEC_FILE);
  if (await statOrNull(specDir)) {
    throw new AgentError(
      "SUBAGENT_ALREADY_EXISTS",
      `子 agent 已存在：${name}（目录 ${specDir}）`,
      409,
      "name",
    );
  }

  const skeleton = buildSpecSkeleton(name, description);
  const body =
    typeof input.systemPrompt === "string" && input.systemPrompt.trim().length > 0
      ? input.systemPrompt
      : parseFrontmatter(skeleton).body;
  const member: SubAgentMember = {
    name,
    dir: specDir,
    specPath,
    valid: true,
    issues: [],
    description,
    tools: null,
    model: null,
    skills: null,
    mode: "isolated",
    systemPrompt: body,
  };
  const content = renderSubAgentSpec(member, skeleton);
  assertRenderedSpec(member, content);
  await fs.mkdir(specDir, { recursive: true });
  await writeTextAtomic(specPath, content);
  return name;
}
// —— 装载（供建图使用）——

export interface TeamIssue {
  name: string;
  dir: string;
  code: string;
  message: string;
}

export interface LoadedTeam {
  agentId: string;
  dir: string;
  teamDir: string;
  exists: boolean;
  /** 仅**合法**成员（非法声明的处置 = 标注 + 跳过，见 spec） */
  members: SubAgentMember[];
  /** 非法声明的清单（供日志 / 排查） */
  issues: TeamIssue[];
}

/** 装载团队：只返回合法成员；非法声明进 `issues`，**不影响其余成员** */
export async function loadTeam(agentId: string): Promise<LoadedTeam> {
  const view = await listTeam(agentId);
  const members: SubAgentMember[] = [];
  const issues: TeamIssue[] = [];
  for (const member of view.members) {
    if (member.valid) {
      members.push(member);
      continue;
    }
    for (const item of member.issues) {
      issues.push({ name: member.name, dir: member.dir, code: item.code, message: item.message });
    }
  }
  return {
    agentId: view.agentId,
    dir: view.dir,
    teamDir: view.teamDir,
    exists: view.exists,
    members,
    issues,
  };
}

export { AGENT_TEAM_DIR, AGENT_TEAM_SPEC_FILE };
