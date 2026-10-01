/**
 * 任务 2.1 – 2.6 的纯函数校验：草稿 ↔ 载荷、工具目录 → 勾选行、标识校验、排序。
 *
 * 为什么全部落在这里：本仓前端没有 jsdom / 没有 fetch 打桩先例，
 * 页面级交互测不了；所以「容易写错又必须对」的逻辑必须能在纯函数层被断言住
 * （尤其是 `tools: null`（继承）与 `tools: []`（一个都不给）的区别）。
 */
import { describe, expect, test } from "bun:test";

import type { SubAgentMember, ToolCatalogGroup } from "@/lib/teamApi";
import {
  INHERIT_MODEL,
  buildToolRows,
  draftsEqual,
  inheritToolsMode,
  issueLabel,
  issuesText,
  memberDraftFrom,
  memberPayload,
  modelOptionLabel,
  normalizeToolSelection,
  parseModelValue,
  sortMembers,
  subAgentIdErrorText,
  toggleToolSelection,
  toolGroupLabel,
  toolSelectionFrom,
  validateSubAgentName,
} from "@/app/utils/teamConfig";
import zh from "@/i18n/zh";

function member(over: Partial<SubAgentMember> = {}): SubAgentMember {
  return {
    name: "trainer",
    dir: "C:/agents/xiaozhu/team/trainer",
    specPath: "C:/agents/xiaozhu/team/trainer/SPEC.md",
    valid: true,
    issues: [],
    description: "训练计划与动作编排",
    tools: null,
    model: null,
    skills: null,
    mode: "isolated",
    systemPrompt: "你是训练教练。",
    ...over,
  };
}

const CATALOG: ToolCatalogGroup[] = [
  { group: "files", enabled: true, tools: ["ls", "read_file", "write_file"] },
  { group: "delegation", enabled: false, tools: ["task"] },
];

describe("成员 → 草稿（2.1 / 2.3）", () => {
  test("tools 缺省（null）→ 继承模式；显式空数组 → 自定义且全不勾", () => {
    expect(memberDraftFrom(member({ tools: null })).toolsMode).toBe("inherit");
    expect(inheritToolsMode(member({ tools: null }))).toBe(true);
    expect(toolSelectionFrom(member({ tools: null }))).toEqual([]);

    const empty = memberDraftFrom(member({ tools: [] }));
    expect(empty.toolsMode).toBe("custom");
    expect(empty.tools).toEqual([]);
    expect(inheritToolsMode(member({ tools: [] }))).toBe(false);
  });

  test("model 缺省 → 继承哨兵；写了模型 → providerId::modelId", () => {
    expect(memberDraftFrom(member({ model: null })).model).toBe(INHERIT_MODEL);
    expect(
      memberDraftFrom(member({ model: { id: "deepseek-chat", providerId: "deepseek" } })).model
    ).toBe("deepseek::deepseek-chat");
    // 老声明没有 providerId，不能编一个出来
    expect(memberDraftFrom(member({ model: { id: "deepseek-chat" } })).model).toBe(
      "deepseek-chat"
    );
  });

  test("正文与描述原样进草稿（正文就是系统提示词）", () => {
    const draft = memberDraftFrom(member());
    expect(draft.description).toBe("训练计划与动作编排");
    expect(draft.systemPrompt).toBe("你是训练教练。");
  });
});

describe("草稿 → 载荷（2.2 / 2.3 / 2.4）", () => {
  test("继承模式提交 tools: null（回到继承，而不是「一个都不给」）", () => {
    const payload = memberPayload({
      description: " 训练 ",
      systemPrompt: "你是训练教练。",
      toolsMode: "inherit",
      tools: ["read_file"],
      model: INHERIT_MODEL,
    });
    expect(payload.tools).toBeNull();
    expect(payload.model).toBeNull();
    expect(payload.description).toBe("训练");
  });

  test("自定义模式：去重、保序、丢空串", () => {
    const payload = memberPayload({
      description: "d",
      systemPrompt: "",
      toolsMode: "custom",
      tools: ["write_file", "read_file", "write_file", "  ", ""],
      model: INHERIT_MODEL,
    });
    expect(payload.tools).toEqual(["write_file", "read_file"]);
  });

  test("自定义但一个都不勾 → 空数组（与继承语义不同）", () => {
    const payload = memberPayload({
      description: "d",
      systemPrompt: "",
      toolsMode: "custom",
      tools: [],
      model: INHERIT_MODEL,
    });
    expect(payload.tools).toEqual([]);
    expect(payload.tools).not.toBeNull();
  });

  test("模型：选了供应商 :: 模型 → 带 providerId 的载荷", () => {
    const payload = memberPayload({
      description: "d",
      systemPrompt: "",
      toolsMode: "inherit",
      tools: [],
      model: "deepseek::deepseek-chat",
    });
    expect(payload.model).toEqual({ id: "deepseek-chat", providerId: "deepseek" });
  });

  test("正文随同一次提交（一个文件一次原子写）", () => {
    const payload = memberPayload({
      description: "d",
      systemPrompt: "你是 reviewer。",
      toolsMode: "inherit",
      tools: [],
      model: INHERIT_MODEL,
    });
    expect(payload.systemPrompt).toBe("你是 reviewer。");
  });
});

describe("草稿相等性（未保存改动）", () => {
  test("工具顺序归一后相等，描述 / 正文 / 模型 / 模式不同则不等", () => {
    const base = memberDraftFrom(member({ tools: ["read_file", "ls"], model: null }));
    expect(draftsEqual(base, { ...base, tools: ["ls", "read_file"] })).toBe(true);
    expect(draftsEqual(base, { ...base, description: "x" })).toBe(false);
    expect(draftsEqual(base, { ...base, systemPrompt: "x" })).toBe(false);
    expect(draftsEqual(base, { ...base, model: "e::m" })).toBe(false);
    expect(draftsEqual(base, { ...base, toolsMode: "inherit" })).toBe(false);
  });
});

describe("工具目录 → 勾选行（2.3）", () => {
  test("分组与勾选状态来自目录，关闭的组被标出来", () => {
    const { groups, unknown } = buildToolRows(CATALOG, ["read_file", "task"]);
    expect(groups.map((item) => item.group)).toEqual(["files", "delegation"]);
    expect(groups[0].enabled).toBe(true);
    expect(groups[1].enabled).toBe(false);
    expect(groups[0].tools.find((item) => item.name === "read_file")?.checked).toBe(true);
    expect(groups[0].tools.find((item) => item.name === "ls")?.checked).toBe(false);
    expect(unknown).toEqual([]);
  });

  test("清单外的工具名被保留并单独列出（不静默丢掉）", () => {
    const { unknown } = buildToolRows(CATALOG, ["read_file", "ghost_tool"]);
    expect(unknown).toEqual(["ghost_tool"]);
  });

  test("空目录不抛错（后端未就绪时给得出空态）", () => {
    expect(buildToolRows([], [])).toEqual({ groups: [], unknown: [] });
  });

  test("勾选 / 取消勾选保序", () => {
    expect(toggleToolSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleToolSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(normalizeToolSelection(["b", "a", "b"])).toEqual(["b", "a"]);
  });

  test("工具组显示名走 i18n，未知组原样显示", () => {
    expect(toolGroupLabel("files")).toBe(zh.agents.toolGroup.files);
    expect(toolGroupLabel("somethingNew")).toBe("somethingNew");
  });
});

describe("模型下拉（2.3）", () => {
  const groups = [
    {
      providerId: "deepseek",
      providerName: "深度求索",
      models: [{ id: "deepseek-chat", name: "对话模型", vision: false }],
    },
  ];

  test("哨兵 → 空串（不写 model 键）", () => {
    expect(parseModelValue(INHERIT_MODEL)).toBe("");
  });

  test("触发器显示清单里的名字；清单外退回原始 id", () => {
    expect(modelOptionLabel("deepseek::deepseek-chat", groups)).toBe("对话模型");
    expect(modelOptionLabel("deepseek::gone", groups)).toBe("gone");
    expect(modelOptionLabel("plain-id", groups)).toBe("plain-id");
    expect(modelOptionLabel(INHERIT_MODEL, groups)).toBe("");
  });
});

describe("非法声明的呈现（2.1）", () => {
  test("已知 issue 码补一句摘要，未知码只用后端原文", () => {
    expect(issueLabel({ code: "MISSING_DESCRIPTION", message: "缺少 description" })).toBe(
      `${zh.team.noDescription} · 缺少 description`
    );
    expect(issueLabel({ code: "WHATEVER", message: "后端说了算" })).toBe("后端说了算");
    expect(
      issuesText([
        { code: "NAME_MISMATCH", message: "name=trainer，目录=coach" },
        { code: "INVALID_YAML", message: "缩进不对" },
      ])
    ).toBe(
      `${zh.team.nameMismatch} · name=trainer，目录=coach；${zh.team.yamlBroken} · 缩进不对`
    );
  });
});

describe("标识校验与排序（2.6）", () => {
  test("四类非法输入各自有可读文案", () => {
    expect(validateSubAgentName("")).toBe("empty");
    expect(validateSubAgentName("a/b")).toBe("separator");
    expect(validateSubAgentName("..")).toBe("dotdot");
    expect(validateSubAgentName("a b")).toBe("whitespace");
    expect(validateSubAgentName("_x")).toBe("charset");
    expect(validateSubAgentName("trainer_2")).toBeNull();
    expect(subAgentIdErrorText(null)).toBeNull();
    expect(subAgentIdErrorText("empty")).toBe(zh.agents.idErrorEmpty);
    expect(subAgentIdErrorText("separator")).toBe(zh.agents.idErrorSeparator);
    expect(subAgentIdErrorText("dotdot")).toBe(zh.agents.idErrorDotDot);
    expect(subAgentIdErrorText("whitespace")).toBe(zh.agents.idErrorWhitespace);
    expect(subAgentIdErrorText("charset")).toBe(zh.agents.idErrorCharset);
  });

  test("排序稳定，且非法成员照样留在列表里", () => {
    const list = [
      member({ name: "zebra" }),
      member({ name: "broken", valid: false, description: "" }),
      member({ name: "alpha" }),
    ];
    const sorted = sortMembers(list);
    expect(sorted.map((item) => item.name)).toEqual(["alpha", "broken", "zebra"]);
    expect(sorted).toHaveLength(3);
    expect(sorted.find((item) => item.name === "broken")?.valid).toBe(false);
    // 不改动入参（纯函数）
    expect(list.map((item) => item.name)).toEqual(["zebra", "broken", "alpha"]);
  });
});
