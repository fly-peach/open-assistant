"use client";

/**
 * 侧边栏的智能体选择器（照 QwenPaw 的 `components/AgentSelector` 做）。
 *
 * 放在侧边栏顶部，回答「这个工作区里现在用哪个助手，还能用哪些」。
 *
 * 与 QwenPaw 的对应关系：
 * - 顶部标题「当前工作区 (N)」+ N = 已启用成员数
 * - 下拉头：「当前工作区」+「管理 ›」→ /agents
 * - 分组：置顶的智能体（默认 agent 恒在其中）/ 其他智能体 / 已停用的智能体（可折叠）
 * - 每行：状态点 · Bot 图标 · 名字（+📌 +✓）· 描述 · 电源开关 · `ID: xxx`
 * - 点已停用的行不切（不做无声切走）
 * - 长按一行 = 置顶/取消置顶
 *
 * 与 QwenPaw 的**差异**（我们的模型决定的）：
 * - 我们没有 agent 的异步启动过程，所以状态只有 `running / disabled / failed`，
 *   不造假 `pending / starting`（见 apps/server/src/agents/registry.ts 的注释）；
 * - 多了一段「可加入的智能体」：QwenPaw 里 agent 天然属于各自的应用，
 *   而我们是从 1:1 放宽来的，需要显式的「加入这个工作区」动作。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Pin, Plus, Power, PowerOff } from "lucide-react";

import {
  getWorkspaceAgents,
  removeWorkspaceAgent,
  setAgentPinned,
  updateWorkspaceAgent,
  type WorkspaceAgentEntry,
  type WorkspaceAgentsView,
} from "@/lib/workspaceAgentsApi";
import zh, { t } from "@/i18n/zh";

const STATUS_COLOR: Record<WorkspaceAgentEntry["startupStatus"], string> = {
  running: "var(--color-success)",
  disabled: "var(--color-text-tertiary)",
  failed: "var(--color-error)",
};

/** 默认 agent 恒置顶，且不可停用/移除（后端也这么强制） */
function isDefaultAgent(id: string): boolean {
  return id === "xiaozhu";
}

/**
 * 状态文字。**停用优先于运行状态**（对齐 QwenPaw 的 `AgentStatusIndicator`：
 * `status ?? (enabled ? pending : disabled)`）——
 * 一个 agent 定义本身没问题（startupStatus=running），但它在这个工作区里被停用了，
 * 显示「运行中」就是错的。
 */
function statusLabel(entry: WorkspaceAgentEntry): string {
  if (!entry.enabled) return zh.agentSelector.statusDisabled;
  if (entry.startupStatus === "failed") return zh.agentSelector.statusFailed;
  return zh.agentSelector.statusRunning;
}

export function AgentSelector({
  workspace,
  onActiveAgentChange,
}: {
  workspace: string | null;
  /** 切了激活位之后通知外面（外面据此把 agentId 写进 URL / 重新拉会话） */
  onActiveAgentChange?: (agentId: string) => void;
}) {
  const [view, setView] = useState<WorkspaceAgentsView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 长按识别：按下时记时间与目标，抬起时判断 */
  const pressRef = useRef<{ id: string; at: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const reload = useCallback(async () => {
    if (!workspace) {
      setView(null);
      return;
    }
    try {
      setView(await getWorkspaceAgents(workspace));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 点外面 / Esc 关闭（没引 popover 依赖，自己管）
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const members = view?.members ?? [];
  const candidates = view?.candidates ?? [];
  const active = members.find((m) => m.active);
  const enabledCount = members.filter((m) => m.enabled).length;

  const pinnedGroup = useMemo(
    () => members.filter((m) => isDefaultAgent(m.id) || m.pinned),
    [members],
  );
  const regularGroup = useMemo(
    () => members.filter((m) => m.enabled && !isDefaultAgent(m.id) && !m.pinned),
    [members],
  );
  const disabledGroup = useMemo(
    () => members.filter((m) => !m.enabled && !isDefaultAgent(m.id) && !m.pinned),
    [members],
  );
  const disabledPinnedGroup = useMemo(
    () => members.filter((m) => !m.enabled && m.pinned),
    [members],
  );

  const act = useCallback(
    async (
      fn: () => Promise<WorkspaceAgentsView | void>,
      opts: { notifyActive?: string } = {},
    ) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await reload();
        if (opts.notifyActive) onActiveAgentChange?.(opts.notifyActive);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onActiveAgentChange, reload],
  );

  const selectAgent = useCallback(
    (entry: WorkspaceAgentEntry) => {
      // 点已停用的行不切（对齐 QwenPaw：不做无声切走）
      if (!entry.enabled || entry.id === view?.activeAgentId) return;
      if (!workspace) return;
      void act(() => updateWorkspaceAgent(workspace, entry.id, { active: true }), {
        notifyActive: entry.id,
      });
      setOpen(false);
    },
    [act, view?.activeAgentId, workspace],
  );

  const toggleEnabled = useCallback(
    (entry: WorkspaceAgentEntry, next: boolean) => {
      if (!workspace) return;
      void act(() => updateWorkspaceAgent(workspace, entry.id, { enabled: next }));
    },
    [act, workspace],
  );

  const togglePin = useCallback(
    (entry: WorkspaceAgentEntry) => {
      if (!workspace || isDefaultAgent(entry.id)) return;
      void act(async () => {
        await setAgentPinned(entry.id, !entry.pinned);
      });
    },
    [act, workspace],
  );

  const addCandidate = useCallback(
    (entry: WorkspaceAgentEntry) => {
      if (!workspace) return;
      void act(() => updateWorkspaceAgent(workspace, entry.id, { add: true, enabled: true }));
    },
    [act, workspace],
  );

  const removeMember = useCallback(
    (entry: WorkspaceAgentEntry) => {
      if (!workspace || isDefaultAgent(entry.id)) return;
      void act(() => removeWorkspaceAgent(workspace, entry.id));
    },
    [act, workspace],
  );

  /** 长按 600ms = 置顶切换；普通点击走 selectAgent */
  const pressHandlers = (entry: WorkspaceAgentEntry) => ({
    onMouseDown: () => {
      const timer = setTimeout(() => {
        pressRef.current = null;
        togglePin(entry);
      }, 600);
      pressRef.current = { id: entry.id, at: Date.now(), timer };
    },
    onMouseUp: () => {
      const press = pressRef.current;
      if (press) {
        clearTimeout(press.timer);
        pressRef.current = null;
      }
    },
    onMouseLeave: () => {
      const press = pressRef.current;
      if (press) {
        clearTimeout(press.timer);
        pressRef.current = null;
      }
    },
  });

  const renderRow = (entry: WorkspaceAgentEntry, opts: { selectable: boolean }) => (
    <div
      key={entry.id}
      data-agent-option={entry.id}
      data-agent-enabled={entry.enabled ? "true" : "false"}
      data-agent-active={entry.active ? "true" : "false"}
      role={opts.selectable ? "option" : undefined}
      aria-selected={opts.selectable ? entry.active : undefined}
      className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left ${
        opts.selectable && entry.enabled ? "cursor-pointer hover:bg-accent" : "cursor-default opacity-80"
      }`}
      onClick={() => opts.selectable && selectAgent(entry)}
      title={
        isDefaultAgent(entry.id)
          ? zh.agentSelector.defaultPinned
          : entry.pinned
            ? zh.agentSelector.longPressToUnpin
            : zh.agentSelector.longPressToPin
      }
      {...(opts.selectable ? pressHandlers(entry) : {})}
    >
      <span
        className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: entry.enabled ? STATUS_COLOR[entry.startupStatus] : STATUS_COLOR.disabled }}
        aria-hidden
      />
      <Bot size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-sm">{entry.name}</span>
          {(isDefaultAgent(entry.id) || entry.pinned) && (
            <Pin size={11} className="shrink-0 text-muted-foreground" aria-label={zh.agentSelector.pinned} />
          )}
          {entry.active && <Check size={13} className="shrink-0 text-[var(--color-success)]" aria-hidden />}
          {(!entry.enabled || entry.startupStatus === "failed") && (
            <span
              className="shrink-0 text-[10px]"
              style={{
                color: entry.startupStatus === "failed" ? "var(--color-error)" : "var(--color-text-tertiary)",
              }}
            >
              {statusLabel(entry)}
            </span>
          )}
        </span>
        {entry.description && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {entry.description}
          </span>
        )}
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
          {t(zh.agentSelector.idLine, { id: entry.id })}
        </span>
      </span>
      <span className="mt-0.5 flex shrink-0 items-center gap-1">
        {opts.selectable && !isDefaultAgent(entry.id) && (
          <button
            type="button"
            data-agent-toggle={entry.id}
            aria-label={
              entry.enabled
                ? t(zh.agentSelector.disable, { name: entry.name })
                : t(zh.agentSelector.enable, { name: entry.name })
            }
            disabled={busy}
            className="rounded p-1 hover:bg-accent"
            onClick={(event) => {
              event.stopPropagation();
              toggleEnabled(entry, !entry.enabled);
            }}
          >
            {entry.enabled ? <Power size={14} /> : <PowerOff size={14} />}
          </button>
        )}
        {opts.selectable && !isDefaultAgent(entry.id) && (
          <button
            type="button"
            data-agent-remove={entry.id}
            aria-label={t(zh.agentSelector.remove, { name: entry.name })}
            disabled={busy}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={(event) => {
              event.stopPropagation();
              removeMember(entry);
            }}
          >
            ×
          </button>
        )}
      </span>
    </div>
  );

  return (
    <div ref={rootRef} className="relative flex-shrink-0 border-b border-border p-3" data-agent-selector>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {zh.agentSelector.currentWorkspace}
          {enabledCount > 0 && (
            <span className="ml-1 text-muted-foreground/70">{`(${enabledCount})`}</span>
          )}
        </span>
      </div>

      <button
        type="button"
        data-agent-selector-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={zh.agentSelector.selectAgent}
        disabled={!workspace}
        onClick={() => setOpen((v) => !v)}
        className="mt-1 flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-sm disabled:opacity-60"
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: active
              ? active.enabled
                ? STATUS_COLOR[active.startupStatus]
                : STATUS_COLOR.disabled
              : STATUS_COLOR.disabled,
          }}
          aria-hidden
        />
        <Bot size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate" data-agent-selector-active>
          {active ? active.name : workspace ? zh.agentSelector.empty : zh.agentSelector.noWorkspace}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {error && (
        <p className="mt-1 text-[11px] text-[var(--color-error)]" data-agent-selector-error>
          {error}
        </p>
      )}

      {open && workspace && (
        <div
          role="listbox"
          aria-label={zh.agentSelector.selectAgent}
          data-agent-selector-menu
          className="absolute left-3 right-3 z-50 mt-1 max-h-[420px] overflow-auto rounded border border-border bg-card p-1 shadow-lg"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {zh.agentSelector.currentWorkspace}
            </span>
            <a
              href="/agents"
              className="flex items-center text-[11px] text-muted-foreground hover:underline"
              data-agent-selector-manage
            >
              {zh.agentSelector.manage}
              <ChevronRight size={11} />
            </a>
          </div>

          {pinnedGroup.length > 0 && (
            <>
              <p className="px-2 pt-1 text-[10px] text-muted-foreground">
                {zh.agentSelector.pinnedGroup}
              </p>
              {pinnedGroup.map((entry) => renderRow(entry, { selectable: true }))}
            </>
          )}

          {regularGroup.length > 0 && (
            <>
              <p className="px-2 pt-2 text-[10px] text-muted-foreground">
                {zh.agentSelector.otherGroup}
              </p>
              {regularGroup.map((entry) => renderRow(entry, { selectable: true }))}
            </>
          )}

          {[...disabledPinnedGroup, ...disabledGroup].length > 0 && (
            <>
              <button
                type="button"
                data-agent-selector-disabled-toggle
                aria-expanded={disabledOpen}
                className="mt-2 flex w-full items-center justify-between px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                onClick={() => setDisabledOpen((v) => !v)}
              >
                <span>
                  {t(zh.agentSelector.disabledGroup, {
                    count: disabledPinnedGroup.length + disabledGroup.length,
                  })}
                </span>
                <ChevronDown
                  size={12}
                  className={disabledOpen ? "rotate-180 transition-transform" : "transition-transform"}
                />
              </button>
              {disabledOpen &&
                [...disabledPinnedGroup, ...disabledGroup].map((entry) =>
                  renderRow(entry, { selectable: true }),
                )}
            </>
          )}

          {candidates.length > 0 && (
            <>
              <button
                type="button"
                data-agent-selector-candidates-toggle
                aria-expanded={candidatesOpen}
                className="mt-2 flex w-full items-center justify-between px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                onClick={() => setCandidatesOpen((v) => !v)}
              >
                <span>{t(zh.agentSelector.candidatesGroup, { count: candidates.length })}</span>
                <ChevronDown
                  size={12}
                  className={candidatesOpen ? "rotate-180 transition-transform" : "transition-transform"}
                />
              </button>
              {candidatesOpen &&
                candidates.map((entry) => (
                  <div
                    key={entry.id}
                    data-agent-candidate={entry.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5"
                  >
                    <Bot size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{entry.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {t(zh.agentSelector.idLine, { id: entry.id })}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-agent-add={entry.id}
                      disabled={busy || !entry.valid}
                      aria-label={t(zh.agentSelector.add, { name: entry.name })}
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
                      onClick={() => addCandidate(entry)}
                    >
                      <Plus size={11} />
                      {zh.agentSelector.add}
                    </button>
                  </div>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AgentSelector;