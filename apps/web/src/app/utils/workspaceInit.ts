/**
 * 工作区初始化的纯展示逻辑（与 UI 解耦，便于单测）。
 *
 * 对齐 design.md Decision #9 / specs/workspace「工作区初始化是显式动作」：
 * - 选定目录后不写文件，只在 `initialized === false` 时展示入口，并说明会写什么；
 * - 两件套（`AGENTS.md` 人设 / `BOOTSTRAP.md` 首次引导）的存在与否分别可见，
 *   因此「只缺一个」与「两个都缺」的文案不同。
 */
import zh, { t } from "@/i18n/zh";
import type { WorkspaceStatus } from "@/lib/workspaceApi";

export interface InitFileItem {
  /** 展示用文件名，如 `AGENTS.md`。 */
  name: string;
  /** 该文件在工作区里的角色（人设 / 首次引导）。 */
  role: string;
  exists: boolean;
}

/** 两件套的逐项状态（顺序固定：人设在前，引导在后）。 */
export function initFileItems(status: WorkspaceStatus): InitFileItem[] {
  return [
    {
      name: zh.workspace.initFileAgents,
      role: zh.workspace.initFileAgentsRole,
      exists: status.files.agentsMd,
    },
    {
      name: zh.workspace.initFileBootstrap,
      role: zh.workspace.initFileBootstrapRole,
      exists: status.files.bootstrapMd,
    },
  ];
}

/** 尚缺（点击初始化时会被补写）的文件名。 */
export function missingInitFiles(status: WorkspaceStatus): string[] {
  return initFileItems(status)
    .filter((item) => !item.exists)
    .map((item) => item.name);
}

/**
 * 入口提示语：说明这次初始化会写入哪些文件。
 * 两件套全缺 / 只缺人设 / 只缺引导 分别有不同文案。
 */
export function initHint(status: WorkspaceStatus): string {
  if (!status.files.agentsMd && !status.files.bootstrapMd) {
    return zh.workspace.initMissingBoth;
  }
  if (!status.files.agentsMd) return zh.workspace.initMissingAgents;
  if (!status.files.bootstrapMd) return zh.workspace.initMissingBootstrap;
  return zh.workspace.initNoneNeeded;
}

/** 初始化结果提示：新建了哪些、跳过了哪些（多行，便于 toast 描述）。 */
export function initResultLines(created: string[], skipped: string[]): string[] {
  const lines: string[] = [];
  if (created.length > 0) {
    lines.push(t(zh.workspace.initCreated, { files: created.join("、") }));
  }
  if (skipped.length > 0) {
    lines.push(t(zh.workspace.initSkipped, { files: skipped.join("、") }));
  }
  if (lines.length === 0) lines.push(zh.workspace.initNoneNeeded);
  return lines;
}