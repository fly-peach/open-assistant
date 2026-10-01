/**
 * 任务 5.1 / 5.4 / 5.5 / 5.7 的纯函数校验：
 * 标识校验、绑定状态推导（未绑定必须阻止）、配置项归一化、短 id。
 */
import { describe, expect, test } from "bun:test";
import {
  APPROVAL_LEVELS,
  approvalOptions,
  canSendWithBinding,
  configApproval,
  configModelId,
  configToolState,
  deriveBindingState,
  formatContacts,
  modelPayload,
  parseContacts,
  shortId,
  sortAgents,
  toolOptions,
  toolsPayload,
  validateAgentId,
} from "@/app/utils/agentConfig";
import type { AgentConfig } from "@/lib/agentsApi";

/** 历史形状的配置（测试兼容读取时用，类型上按未知值处理）。 */
const looseConfig = (raw: unknown) => raw as AgentConfig;

describe("智能体标识校验（5.1）", () => {
  test("拒绝路径分隔符 / .. / 空白 / 空", () => {
    expect(validateAgentId("")).toBe("empty");
    expect(validateAgentId("   ")).toBe("empty");
    expect(validateAgentId("a/b")).toBe("separator");
    expect(validateAgentId("a\\b")).toBe("separator");
    expect(validateAgentId("..")).toBe("dotdot");
    expect(validateAgentId("a..b")).toBe("dotdot");
    expect(validateAgentId("a b")).toBe("whitespace");
    expect(validateAgentId("_lead")).toBe("charset");
    expect(validateAgentId("小助")).toBe("charset");
  });

  test("接受字母数字与 - _", () => {
    expect(validateAgentId("xiaozhu")).toBeNull();
    expect(validateAgentId("a-b_c1")).toBeNull();
  });
});

describe("绑定状态推导（5.4）", () => {
  const bound = { agentId: "xiaozhu", agentName: "小助" };

  test("未选工作区 / 读取失败 / 加载中各自可辨认", () => {
    expect(deriveBindingState(null, null, null, false).state).toBe("no-workspace");
    expect(deriveBindingState(null, null, new Error("x"), true).state).toBe("unknown");
    expect(deriveBindingState(undefined, null, null, true).state).toBe("loading");
  });

  test("未绑定：能读出来且有明确状态（不静默用默认 agent 代跑）", () => {
    const view = deriveBindingState({ agentId: null }, ["xiaozhu"], null, true);
    expect(view.state).toBe("none");
    expect(view.agentId).toBeNull();
  });

  test("已绑定：带上名称", () => {
    const view = deriveBindingState(bound, ["xiaozhu"], null, true);
    expect(view).toEqual({
      state: "bound",
      agentId: "xiaozhu",
      agentName: "小助",
      knownAgentIds: ["xiaozhu"],
    });
  });

  test("绑定的 agent 在根目录下不存在 → missing-agent", () => {
    expect(deriveBindingState(bound, ["other"], null, true).state).toBe("missing-agent");
  });

  test("未绑定 / agent 不存在必须阻止发送；读不到绑定状态时不阻止（后端仍校验）", () => {
    expect(canSendWithBinding("none")).toBe(false);
    expect(canSendWithBinding("missing-agent")).toBe(false);
    expect(canSendWithBinding("bound")).toBe(true);
    expect(canSendWithBinding("loading")).toBe(true);
    expect(canSendWithBinding("unknown")).toBe(true);
  });
});

describe("配置项归一化（5.2）", () => {
  test("工具白名单是布尔映射（与后端 config.ts 一致）", () => {
    expect(configToolState({ tools: { files: true, peers: false } })).toEqual({
      files: true,
      peers: false,
    });
    expect(configToolState(undefined)).toEqual({});
  });

  test("兼容读取历史形状（allow 数组 / 字符串数组），但写回只带布尔", () => {
    const fromAllow = configToolState(looseConfig({ tools: { allow: ["files"] } }));
    expect(fromAllow.files).toBe(true);
    expect(fromAllow.todos).toBe(false);
    const fromArray = configToolState(looseConfig({ tools: ["files", "todos"] }));
    expect(fromArray.files).toBe(true);
    expect(fromArray.todos).toBe(true);
    expect(toolsPayload({ files: true, custom: true, broken: undefined as unknown as boolean })).toEqual({
      files: true,
      custom: true,
    });
  });

  test("审批级别以后端合法集合为准，未知取值不被静默丢弃", () => {
    expect(configApproval({ approval: "confirm" })).toBe("confirm");
    expect(approvalOptions("custom")).toContain("custom");
    expect(APPROVAL_LEVELS).toEqual(["auto", "confirm", "strict"]);
  });

  test("模型是 { id, baseUrl? } | null，留空即 null 且保留 baseUrl", () => {
    expect(configModelId({ model: { id: "qwen-plus", baseUrl: "http://x" } })).toBe("qwen-plus");
    expect(configModelId({ model: null })).toBe("");
    expect(modelPayload("  ", { model: { id: "a", baseUrl: "http://x" } })).toBeNull();
    expect(modelPayload("qwen-max", { model: { id: "a", baseUrl: "http://x" } })).toEqual({
      id: "qwen-max",
      baseUrl: "http://x",
    });
  });

  test("工具选项保留配置里已有的未知组", () => {
    expect(toolOptions({ customGroup: true })).toContain("customGroup");
    expect(toolOptions({})).toContain("peers");
  });

  test("可联系名单：逗号 / 换行 / 中文逗号都能解析", () => {
    expect(parseContacts("reviewer, xiaozhu，other\npeer")).toEqual([
      "reviewer",
      "xiaozhu",
      "other",
      "peer",
    ]);
    expect(formatContacts(["a", "b"])).toBe("a, b");
    expect(formatContacts(undefined)).toBe("");
  });
});

describe("展示工具（5.6 / 5.7）", () => {
  test("短 id 取前 8 位，不足 8 位原样返回", () => {
    expect(shortId("0f0e9d8c-1111-2222-3333-444455556666")).toBe("0f0e9d8c");
    expect(shortId("abc")).toBe("abc");
  });

  test("列表排序稳定（按标识）", () => {
    const sorted = sortAgents([
      { id: "b", name: "B", valid: true, main: false },
      { id: "a", name: "A", valid: false, issues: ["缺人设"], main: false },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });
});