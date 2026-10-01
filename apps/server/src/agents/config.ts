/**
 * agent 配置结构、默认值与校验（tasks 1.5，对齐 specs/agent-registry「Agent 的配置项」）。
 *
 * 配置项：模型 / 工具白名单 / 审批级别 / 同侪开关 / 可联系名单。
 *
 * 两条硬约束（spec 明确要求）：
 * - **缺字段用默认**：MUST NOT 因缺字段而拒绝加载；
 * - **非法取值拒绝加载**：超出允许范围时指出具体字段，MUST NOT 静默用默认值掩盖。
 */
import { AgentError } from "./errors.js";

/**
 * 工具组 → 工具名映射。
 *
 * 白名单以「组」为单位（前端配置页按组开关），运行期按工具名反查所属组。
 * 不在任何组里的工具视为结构性工具（deepagents 内部工具等），默认放行 ——
 * 白名单只负责「关掉已知的组」，不负责「枚举未来所有工具」。
 */
export const TOOL_GROUPS = {
  files: ["ls", "read_file", "write_file", "edit_file", "glob", "grep"],
  todos: ["todo_list", "todo_create", "todo_update", "todo_delete"],
  persona: ["persona_write"],
  memory: ["memory_search", "memory_read", "memory_note", "memory_core"],
  delegation: ["task"],
  crossAgent: ["ask_agent"],
  peers: ["ask_peer"],
} as const satisfies Record<string, readonly string[]>;

export type ToolGroup = keyof typeof TOOL_GROUPS;

export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** 工具组默认开关：核心能力默认开；委派 / 跨 agent / 同侪默认关（结构性防递归，design D6） */
export const DEFAULT_TOOLS: Record<ToolGroup, boolean> = {
  files: true,
  todos: true,
  persona: true,
  memory: true,
  delegation: false,
  crossAgent: false,
  peers: false,
};

/** 审批级别（唯一的合法取值集合；出现别的值即拒绝加载） */
export const APPROVAL_LEVELS = ["auto", "confirm", "strict"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export interface AgentModelConfig {
  id: string;
  /**
   * 供应商标识（`models.json` 里的 provider id）。
   *
   * 历史配置只有 `{ id, baseUrl }`，没有这个字段 —— 所以它是可选的：
   * 缺省时运行期按 baseUrl 反查供应商，查不到再回落全局默认（见 models/resolve.ts）。
   * 新写入一律带上它，避免「同名模型在不同供应商下指错端点」。
   */
  providerId?: string;
  baseUrl?: string;
}

export interface AgentConfig {
  version: 1;
  name: string;
  description: string;
  model: AgentModelConfig | null;
  tools: Record<ToolGroup, boolean>;
  approval: ApprovalLevel;
  allowSiblingInteraction: boolean;
  contactableAgents: string[];
}

export interface AgentConfigDefaults {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
}

/** 新 agent 的默认配置（模型 null → 用 provider 默认；同侪开关默认关） */
export function defaultAgentConfig(defaults: AgentConfigDefaults): AgentConfig {
  return {
    version: 1,
    name: defaults.name?.trim() ? defaults.name.trim() : defaults.id,
    description: defaults.description?.trim() ?? "",
    model: null,
    tools: { ...DEFAULT_TOOLS },
    approval: "auto",
    allowSiblingInteraction: false,
    contactableAgents: [],
  };
}

const KNOWN_KEYS = new Set([
  "version",
  "name",
  "description",
  "model",
  "tools",
  "approval",
  "allowSiblingInteraction",
  "contactableAgents",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把磁盘上的原始配置（可能缺字段 / 含非法值）归一化成完整配置。
 * 缺字段 → 默认值；非法值 → 收集后一次性抛 AGENT_INVALID_CONFIG（带字段名）。
 */
export function normalizeAgentConfig(
  raw: unknown,
  context: string,
  defaults: { id: string },
): AgentConfig {
  const config = defaultAgentConfig({ id: defaults.id });
  if (raw === undefined || raw === null) return config;
  if (!isPlainObject(raw)) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `${context} 配置必须是一个 JSON 对象`,
      400,
      "config",
    );
  }

  const issues: Array<{ field: string; message: string }> = [];
  const addIssue = (field: string, message: string) => issues.push({ field, message });

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) addIssue(key, `未知字段 ${JSON.stringify(key)}`);
  }

  if (raw["version"] !== undefined && raw["version"] !== 1) {
    addIssue("version", `version 只能是 1（收到 ${JSON.stringify(raw["version"])}）`);
  }

  if (raw["name"] !== undefined) {
    if (typeof raw["name"] !== "string") addIssue("name", "name 必须是字符串");
    else if (raw["name"].trim().length > 0) config.name = raw["name"].trim();
  }

  if (raw["description"] !== undefined) {
    if (typeof raw["description"] !== "string") addIssue("description", "description 必须是字符串");
    else config.description = raw["description"];
  }

  if (raw["model"] !== undefined) {
    const model = raw["model"];
    if (model === null) {
      config.model = null;
    } else if (!isPlainObject(model)) {
      addIssue("model", "model 必须是对象或 null");
    } else {
      const modelIssueFields: string[] = [];
      const id = model["id"];
      if (typeof id !== "string" || id.trim().length === 0) modelIssueFields.push("id");
      const providerId = model["providerId"];
      if (providerId !== undefined && (typeof providerId !== "string" || providerId.trim().length === 0)) {
        modelIssueFields.push("providerId");
      }
      const baseUrl = model["baseUrl"];
      if (baseUrl !== undefined && typeof baseUrl !== "string") modelIssueFields.push("baseUrl");
      const unknownModelKeys = Object.keys(model).filter(
        (k) => k !== "id" && k !== "providerId" && k !== "baseUrl",
      );
      if (unknownModelKeys.length > 0) modelIssueFields.push(...unknownModelKeys);
      if (modelIssueFields.length > 0) {
        addIssue("model", `model 的字段非法：${modelIssueFields.join("、")}`);
      } else {
        config.model = {
          id: (id as string).trim(),
          ...(typeof providerId === "string" && providerId.trim().length > 0
            ? { providerId: providerId.trim() }
            : {}),
          ...(typeof baseUrl === "string" && baseUrl.trim().length > 0
            ? { baseUrl: baseUrl.trim() }
            : {}),
        };
      }
    }
  }

  if (raw["tools"] !== undefined) {
    const tools = raw["tools"];
    if (!isPlainObject(tools)) {
      addIssue("tools", "tools 必须是对象");
    } else {
      for (const [group, value] of Object.entries(tools)) {
        if (!(TOOL_GROUP_NAMES as string[]).includes(group)) {
          addIssue("tools", `tools 含未知工具组 ${JSON.stringify(group)}`);
          continue;
        }
        if (typeof value !== "boolean") {
          addIssue(`tools.${group}`, `tools.${group} 必须是布尔值`);
          continue;
        }
        config.tools[group as ToolGroup] = value;
      }
    }
  }

  if (raw["approval"] !== undefined) {
    const approval = raw["approval"];
    if (typeof approval !== "string" || !(APPROVAL_LEVELS as readonly string[]).includes(approval)) {
      addIssue(
        "approval",
        `approval 只能是 ${APPROVAL_LEVELS.join(" / ")}（收到 ${JSON.stringify(approval)}）`,
      );
    } else {
      config.approval = approval as ApprovalLevel;
    }
  }

  if (raw["allowSiblingInteraction"] !== undefined) {
    if (typeof raw["allowSiblingInteraction"] !== "boolean") {
      addIssue("allowSiblingInteraction", "allowSiblingInteraction 必须是布尔值");
    } else {
      config.allowSiblingInteraction = raw["allowSiblingInteraction"];
    }
  }

  if (raw["contactableAgents"] !== undefined) {
    const list = raw["contactableAgents"];
    if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
      addIssue("contactableAgents", "contactableAgents 必须是字符串数组");
    } else {
      config.contactableAgents = list.map((v) => (v as string).trim()).filter((v) => v.length > 0);
    }
  }

  if (issues.length > 0) {
    throw new AgentError(
      "AGENT_INVALID_CONFIG",
      `${context} 配置非法：${issues.map((i) => i.message).join("；")}`,
      400,
      issues[0]!.field,
    );
  }
  return config;
}

/** 工具名 → 所属工具组；不属于任何已知组 → null（结构性工具，默认放行） */
export function toolGroupOf(toolName: string): ToolGroup | null {
  for (const group of TOOL_GROUP_NAMES) {
    if ((TOOL_GROUPS[group] as readonly string[]).includes(toolName)) return group;
  }
  return null;
}

export interface ToolGate {
  allowed: boolean;
  group: ToolGroup | null;
  reason?: string;
}

/**
 * 该 agent 的配置是否允许调用某工具（运行期权限边界）。
 * - 白名单组被关掉 → 不允许；
 * - `ask_peer` 额外要求「同侪开关」为开（design D6）。
 */
export function gateTool(config: AgentConfig, toolName: string): ToolGate {
  const group = toolGroupOf(toolName);
  if (group === null) return { allowed: true, group: null };
  if (config.tools[group] !== true) {
    return { allowed: false, group, reason: `工具组 ${group} 已被该 agent 的配置关闭` };
  }
  if (group === "peers" && config.allowSiblingInteraction !== true) {
    return { allowed: false, group, reason: "该 agent 的「允许与同级 agent 交互」开关未开启" };
  }
  return { allowed: true, group };
}