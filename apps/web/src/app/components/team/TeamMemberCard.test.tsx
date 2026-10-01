/**
 * 任务 2.1 / 2.3 的组件级验证：**非法声明在界面上可见且带原因**，
 * 以及「进阶字段懒挂载」「被主 agent 关掉的工具组被标出来」。
 *
 * 本仓前端没有 jsdom，页面级交互（改字段 → 点保存 → 看落盘）测不了，
 * 所以这里只用真实契约形状的 payload 喂给卡片，断言静态标记渲染正确（不依赖网络）。
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TeamMemberCard } from "@/app/components/team/TeamMemberCard";
import zh from "@/i18n/zh";
import type { SubAgentMember, ToolCatalogGroup } from "@/lib/teamApi";

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

function render(props: Partial<React.ComponentProps<typeof TeamMemberCard>> = {}) {
  return renderToStaticMarkup(
    React.createElement(TeamMemberCard, {
      member: member(),
      catalog: CATALOG,
      modelGroups: [],
      modelsReady: true,
      onSave: async () => {},
      ...props,
    })
  );
}

describe("子 agent 卡片（2.1）", () => {
  test("合法成员渲染名称 / 描述 / 正文，且不带非法告警", () => {
    const html = render();
    expect(html).toContain('data-team-member="trainer"');
    expect(html).toContain('data-team-member-valid="true"');
    expect(html).toContain("训练计划与动作编排");
    expect(html).toContain("你是训练教练。");
    expect(html).toContain(zh.team.descriptionLabel);
    expect(html).toContain(zh.team.promptLabel);
    expect(html).toContain(`data-team-save="trainer"`);
    // 合法的成员不该出现非法告警
    expect(html).not.toContain("data-team-issues");
    expect(html).not.toContain(zh.team.invalid);
  });

  test("非法成员：标出 valid=false 并渲染原因（含路径）", () => {
    const html = render({
      member: member({
        valid: false,
        description: "",
        issues: [
          { code: "MISSING_DESCRIPTION", message: "缺少路由描述（description），路径 …/broken/SPEC.md" },
        ],
      }),
    });
    expect(html).toContain('data-team-member-valid="false"');
    expect(html).toContain('data-team-issues="trainer"');
    expect(html).toContain(zh.team.invalid);
    expect(html).toContain("缺少路由描述");
    expect(html).toContain("SPEC.md");
    // 描述被清空时，输入框下方即时提示
    expect(html).toContain(`data-team-description-empty="trainer"`);
  });

  test("拿到的是未声明（继承）的工具清单：继承模式 + 不渲染勾选网格", () => {
    const html = render({ member: member({ tools: null }) });
    expect(html).toContain(`data-team-tools="trainer"`);
    expect(html).toContain('data-team-tools-mode="inherit"');
    expect(html).not.toContain("data-team-tools-grid");
  });

  test("自定义工具清单：勾选网格渲染出来，被主 agent 关掉的组被标出来（2.3）", () => {
    const html = render({ member: member({ tools: ["read_file", "task"] }) });
    expect(html).toContain('data-team-tools-mode="custom"');
    expect(html).toContain('data-team-tools-group="files"');
    expect(html).toContain('data-team-tools-group-enabled="false"');
    expect(html).toContain('data-team-tools-group-disabled="delegation"');
    expect(html).toContain(zh.team.toolsGroupDisabled);
    // 勾选状态可见（read_file 勾了、ls 没勾）
    expect(html).toContain('data-team-tool-enabled="true"');
    expect(html).toContain('data-team-tool-enabled="false"');
  });

  test("进阶字段懒挂载：折叠时不渲染 skills / mode", () => {
    const collapsed = render({ member: member({ skills: ["review"], mode: "fork" }) });
    expect(collapsed).toContain('data-team-advanced-toggle="trainer"');
    expect(collapsed).not.toContain('data-team-advanced="');
    expect(collapsed).not.toContain(zh.team.skillsLabel);
    expect(collapsed).not.toContain(zh.team.modeLabel);
  });

  test("刚加载的卡片不谎称「已保存」（只有真的保存过才显示）", () => {
    expect(render()).not.toContain("data-team-saved");
    expect(render()).not.toContain("data-team-save-error");
  });
});
