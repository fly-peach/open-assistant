/**
 * 智能体档案视图（选择器用）。
 *
 * 照 QwenPaw 的 `AgentProfileRef { id, workspace_dir, enabled, pinned }`：
 * **每个 agent 有自己的工作区目录，agent ↔ 目录是 1:1。**
 * 选择器列的是这份名单；选一个就是「切到它维护的那个工作区」（连带切 agent）。
 *
 * 名单的事实源是 agent 自己的 `config.json`（我们这边 agent 目录本身就是档案），
 * 而「当前这个目录归谁」的另一半在 `<工作区>/.open-assistant/project.json`。
 * 两份记录互为镜像 —— 这里把它们合起来给界面看。
 */
import { listAgents, type AgentStartupStatus } from "./agents/registry.js";
import { readBinding } from "./binding.js";
import { resolveWorkspaceDir } from "./workspace.js";

/** 路径归一化比较：Windows 的大小写 / 分隔符 / 结尾分隔符都算同一个目录 */
function samePath(left: string, right: string): boolean {
  const norm = (v: string): string => {
    let out = v.replaceAll(String.fromCharCode(92), "/");
    if (out.endsWith("/")) out = out.slice(0, -1);
    return out.toLowerCase();
  };
  return norm(left) === norm(right);
}

export interface AgentProfileEntry {
  id: string;
  name: string;
  description?: string;
  /** 这个 agent 维护的目录；null = 还没指定工作区（选择器里能看到但切不过去） */
  workspaceDir: string | null;
  enabled: boolean;
  pinned: boolean;
  availableInChat: boolean;
  startupStatus: AgentStartupStatus;
  valid: boolean;
  issues?: string[];
  /** 是「当前工作区」正在用的那位吗 */
  active: boolean;
}

export interface AgentProfilesView {
  /** 当前工作区（绝对路径；未指定工作区时为空串） */
  currentWorkspace: string;
  /** 当前工作区绑定的 agent；未绑定 → null */
  activeAgentId: string | null;
  agents: AgentProfileEntry[];
}

/**
 * 汇总选择器需要的一切。
 * `currentWorkspace` 可以传空（还没有工作区时界面照样要能列出名单）。
 */
export async function readAgentProfilesView(
  currentWorkspace: string,
): Promise<AgentProfilesView> {
  const workspaceDir = currentWorkspace ? await resolveWorkspaceDir(currentWorkspace) : "";
  const binding = workspaceDir ? await readBinding(workspaceDir) : null;
  const { agents } = await listAgents();
  // 绑定是权威；但目录还没绑定过时，用「谁认领了它」兜底 ——
  // agent 的 config 已经写着「我维护这个目录」，那时界面不该说「未绑定」。
  const claimant = workspaceDir
    ? agents.find((a) => a.workspaceDir && samePath(a.workspaceDir, workspaceDir))
    : undefined;
  const activeAgentId = binding?.agentId ?? claimant?.id ?? null;
  const entries: AgentProfileEntry[] = agents.map((summary) => {
    const entry: AgentProfileEntry = {
      id: summary.id,
      name: summary.name,
      // 镜像兜底：绑定说「这个目录归它」，但它的 config 里还没写上（老数据）
      // → 以绑定为准，否则界面会显示「未指定工作区」而实际上它正在用着
      workspaceDir:
        summary.workspaceDir ?? (summary.id === activeAgentId ? workspaceDir || null : null),
      enabled: summary.enabled,
      pinned: summary.pinned,
      availableInChat: summary.availableInChat,
      startupStatus: summary.valid ? "running" : "failed",
      valid: summary.valid,
      active: summary.id === activeAgentId,
    };
    if (summary.description !== undefined) entry.description = summary.description;
    if (summary.issues !== undefined) entry.issues = summary.issues;
    return entry;
  });

  return { currentWorkspace: workspaceDir, activeAgentId, agents: entries };
}

/**
 * 选择器里「能不能切过去」。
 *
 * 这是这条规则的**权威定义**，前端 `agentProfilesApi.switchBlockReason` 是它的镜像
 * （前端不能 import 服务端代码，所以那份是复制的；改规则时两边要一起改）。
 * 返回原因码而不是句子：措辞属于界面，规则属于这里。
 */
export function switchBlockReason(entry: AgentProfileEntry): string | null {
  if (!entry.enabled) return "disabled";
  if (entry.valid === false) return "invalid";
  if (!entry.workspaceDir) return "no-workspace";
  return null;
}