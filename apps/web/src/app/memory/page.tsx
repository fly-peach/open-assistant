"use client";

/**
 * 记忆页（路由 `/memory`；任务 6.3 的「单文件两个分栏」在任务 11.18 改为**两级导航的浏览器**）。
 *
 * 结构（对齐 design.md D12 与 specs/project-wiki）：
 *
 * ```
 * 记忆
 * ├── 智能体长期记忆（跨工作区）  → GET /agents/{id}/memory[/tree|/file]
 * └── 项目 wiki（本工作区）        → GET /workspace/tree|file（wiki 在工作区根目录）
 * ```
 *
 * 一级 = 左栏的两个「范围」节点（激活哪个，右侧预览就属于哪个）；二级 = 各范围内的文件树。
 * 没数据时每一级都给可读空状态：
 * - 记忆清单接口未就绪 → 可读错误态 + 说明，核心 `MEMORY.md` 仍可编辑（不丢已有功能）；
 * - 工作区里没有 `wiki/` → 「空 wiki」（spec「wiki 不存在时不报错」）；
 * - 未选工作区 / 未绑定智能体 → 沿用既有的可读阻塞说明。
 *
 * 范围之间互不串台：两个范围各自记住自己的选中文件，切换范围不会把 A 的内容带进 B。
 */
import { useCallback, useState } from "react";
import { BookText, Brain, Bot, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemoryEditor } from "@/app/components/memory/MemoryEditor";
import { MemoryScopeSection } from "@/app/components/memory/MemoryScopeSection";
import {
  AgentMemoryTree,
  AGENT_CORE_REL,
} from "@/app/components/memory/AgentMemoryTree";
import { AgentMemoryFilePreview } from "@/app/components/memory/AgentMemoryFilePreview";
import { WikiTree } from "@/app/components/memory/WikiTree";
import { FilePreview } from "@/app/components/workspace/FilePreview";
import { useWorkspaceContext } from "@/providers/WorkspaceProvider";
import { useBindingState } from "@/app/hooks/useAgents";
import { getAgentMemory, putAgentMemory } from "@/lib/agentsApi";
import { isWikiRawRel } from "@/app/utils/memoryTree";
import zh, { t } from "@/i18n/zh";

type Scope = "agent" | "wiki";

/** 一级节点文案与图标（数据表，避免在 JSX 里堆条件）。 */
const SCOPES: { key: Scope; title: string; description: string; icon: React.ReactNode }[] = [
  {
    key: "agent",
    title: zh.memory.agentTab,
    description: zh.memory.agentScopeDesc,
    icon: <Bot size={15} className="shrink-0 text-[#7c3aed]" aria-hidden />,
  },
  {
    key: "wiki",
    title: zh.memory.wikiScope,
    description: zh.memory.wikiScopeDesc,
    icon: <BookText size={15} className="shrink-0 text-[#047857]" aria-hidden />,
  },
];

function EmptyBlock({ testId, title, hint }: { testId: string; title: string; hint: string }) {
  return (
    <div
      className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
      data-memory-empty={testId}
    >
      <p className="font-medium text-[var(--color-text-secondary)]">{title}</p>
      <p className="mt-1 text-xs">{hint}</p>
    </div>
  );
}

export default function MemoryPage() {
  const { workspacePath } = useWorkspaceContext();
  const binding = useBindingState(workspacePath);

  const agentId = binding.state === "bound" ? binding.agentId : null;

  const agentBlockedReason = !workspacePath
    ? zh.memory.noWorkspace
    : binding.state === "none"
      ? zh.memory.unbound
      : binding.state === "missing-agent"
        ? t(zh.memory.absentAgent, { id: binding.agentId ?? "" })
        : binding.state === "loading"
          ? zh.common.loading
          : binding.state === "unknown"
            ? t(zh.memory.bindFailed, {
                error:
                  binding.error instanceof Error
                    ? binding.error.message
                    : String(binding.error ?? ""),
              })
            : null;

  // 一级导航当前激活范围（右侧预览跟随），以及每个范围的展开状态与选中文件。
  const [scope, setScope] = useState<Scope>("agent");
  const [open, setOpen] = useState<Record<Scope, boolean>>({ agent: true, wiki: true });
  const [selected, setSelected] = useState<Record<Scope, string | null>>({
    agent: null,
    wiki: null,
  });
  const [revision, setRevision] = useState(0);

  const activate = useCallback((next: Scope) => {
    setScope(next);
    setOpen((prev) => ({ ...prev, [next]: true }));
  }, []);

  const toggle = useCallback((target: Scope) => {
    setOpen((prev) => ({ ...prev, [target]: !prev[target] }));
  }, []);

  const selectFile = useCallback(
    (target: Scope, rel: string) => {
      setScope(target);
      setSelected((prev) => ({ ...prev, [target]: rel }));
    },
    []
  );

  const agentSelected = selected.agent;
  const wikiSelected = selected.wiki;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-memory-page
    >
      <header className="flex items-start gap-2 px-6 pt-6">
        <Brain
          size={18}
          aria-hidden
          className="mt-1 shrink-0"
        />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{zh.memory.title}</h1>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{zh.memory.hint}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => setRevision((prev) => prev + 1)}
          aria-label={zh.memory.refresh}
          title={zh.memory.refresh}
          data-memory-refresh
        >
          <RefreshCw size={14} />
          <span className="ml-1">{zh.memory.refresh}</span>
        </Button>
      </header>

      <div className="mt-4 flex min-h-0 flex-1 gap-3 px-6 pb-6">
        {/* 一级 + 二级导航：左栏 */}
        <aside
          className="w-[320px] shrink-0 overflow-auto rounded-md border border-border bg-card py-1"
          aria-label={zh.memory.browserLabel}
          data-memory-tree-pane
        >
          {SCOPES.map((item) => (
            <MemoryScopeSection
              key={item.key}
              scope={item.key}
              title={item.title}
              description={item.description}
              icon={item.icon}
              active={scope === item.key}
              open={open[item.key]}
              onActivate={() => activate(item.key)}
              onToggle={() => toggle(item.key)}
              toggleLabel={t(zh.memory.toggleScope, { name: item.title })}
            >
              {item.key === "agent" ? (
                agentId ? (
                  <AgentMemoryTree
                    agentId={agentId}
                    revision={revision}
                    selectedRel={agentSelected}
                    onSelectFile={(rel) => selectFile("agent", rel)}
                  />
                ) : (
                  <p
                    className="mx-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
                    data-memory-scope-blocked="agent"
                  >
                    {agentBlockedReason}
                  </p>
                )
              ) : workspacePath ? (
                <WikiTree
                  workspacePath={workspacePath}
                  revision={revision}
                  selectedRel={wikiSelected}
                  onSelectFile={(rel) => selectFile("wiki", rel)}
                />
              ) : (
                <p
                  className="mx-1 rounded border border-dashed border-border p-2 text-xs text-muted-foreground"
                  data-memory-scope-blocked="wiki"
                >
                  {zh.memory.wikiUnavailable}
                </p>
              )}
            </MemoryScopeSection>
          ))}
        </aside>

        {/* 右侧预览 */}
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col rounded-md border border-border bg-card"
          aria-label={zh.memory.previewLabel}
          data-memory-preview={scope}
          data-memory-selected={selected[scope] ?? ""}
        >
          {scope === "agent" ? (
            agentBlockedReason ? (
              <div className="p-3">
                <EmptyBlock
                  testId="agent-blocked"
                  title={zh.memory.agentTab}
                  hint={agentBlockedReason}
                />
              </div>
            ) : agentSelected === null ? (
              <div className="p-3">
                <EmptyBlock
                  testId="agent-none"
                  title={zh.memory.noFileSelected}
                  hint={zh.memory.pickFileHint}
                />
              </div>
            ) : agentSelected === AGENT_CORE_REL ? (
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <MemoryEditor
                  scope="agent-core"
                  title={zh.memory.coreTitle}
                  description={zh.memory.coreDesc}
                  targetLabel={
                    agentId
                      ? t(zh.memory.agentTarget, { name: binding.agentName })
                      : undefined
                  }
                  placeholder={zh.memory.placeholderAgent}
                  reloadKey={`agent-core:${agentId ?? "none"}:${revision}`}
                  loadErrorMessage={zh.memory.loadFailed}
                  load={() => getAgentMemory(agentId as string)}
                  save={(content) => putAgentMemory(agentId as string, content)}
                />
              </div>
            ) : (
              <AgentMemoryFilePreview
                agentId={agentId as string}
                rel={agentSelected}
                revision={revision}
              />
            )
          ) : !workspacePath ? (
            <div className="p-3">
              <EmptyBlock
                testId="wiki-blocked"
                title={zh.memory.wikiScope}
                hint={zh.memory.wikiUnavailable}
              />
            </div>
          ) : wikiSelected === null ? (
            <div className="p-3">
              <EmptyBlock
                testId="wiki-none"
                title={zh.memory.noFileSelected}
                hint={zh.memory.pickFileHint}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {isWikiRawRel(wikiSelected) && (
                <p
                  className="flex items-center gap-1 border-b border-border bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-warning)]"
                  data-memory-readonly-badge={zh.memory.rawReadonly}
                >
                  {zh.memory.rawReadonly}
                  <span className="text-muted-foreground">— {zh.memory.rawHint}</span>
                </p>
              )}
              <FilePreview
                workspacePath={workspacePath}
                path={wikiSelected}
                revision={revision}
                onFileChanged={() => setRevision((prev) => prev + 1)}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}