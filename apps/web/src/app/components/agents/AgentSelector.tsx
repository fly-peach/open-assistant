"use client";

/**
 * 侧边栏的智能体选择器（照 QwenPaw 的 `components/AgentSelector`）。
 *
 * 它回答的问题是：**「现在是谁在维护这个工作区？我还能切到谁？」**
 *
 * 模型（1:1，照 QwenPaw `AgentProfileRef { id, workspace_dir, ... }`）：
 * 每个 agent 有自己的工作区目录，所以**切换 agent = 切换到它维护的那个目录**。
 * 这正是 QwenPaw 里下拉框标题写着「当前工作区」的原因 —— 选项背后是一个个目录。
 *
 * 与 QwenPaw 的对应：
 * - 标题「当前工作区 (N)」，N = 可用 agent 数
 * - 下拉头：「当前工作区」+「管理 ›」→ /agents
 * - 分组：置顶的智能体（默认 agent 恒在其中）/ 其他智能体 / 已停用的智能体（可折叠）
 * - 每行：状态点 · Bot · 名字（+📌 +✓）· 描述 · 工作区目录 · `ID: xxx` · 电源开关
 * - 点停用 / 未指定工作区的行不切走
 * - 长按一行 = 置顶 / 取消置顶
 * - 不提供「删除」：那属于 /agents 管理页的事（QwenPaw 也是这么分的）
 *
 * 差异：我们的状态只发 `running / disabled / failed`，不造假 `pending / starting`
 * （我们的 agent 是文件定义，没有异步启动过程）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Pin, Power, PowerOff } from "lucide-react";

import {
  getAgentProfiles,
  setAgentEnabled,
  setAgentPinned,
  switchBlockReason,
  type AgentProfileEntry,
  type AgentProfilesView,
} from "@/lib/agentProfilesApi";
import zh, { t } from "@/i18n/zh";

const STATUS_COLOR: Record<AgentProfileEntry["startupStatus"], string> = {
  running: "var(--color-success)",
  disabled: "var(--color-text-tertiary)",
  failed: "var(--color-error)",
};

function isMainAgent(entry: AgentProfileEntry): boolean {
  return entry.main;
}

/** 停用优先于运行状态（对齐 QwenPaw 的 `status ?? (enabled ? pending : disabled)`） */
function statusLabel(entry: AgentProfileEntry): string {
  if (!entry.enabled) return zh.agentSelector.statusDisabled;
  if (entry.startupStatus === "failed") return zh.agentSelector.statusFailed;
  return zh.agentSelector.statusRunning;
}

function blockMessage(entry: AgentProfileEntry): string | null {
  const reason = switchBlockReason(entry);
  if (reason === "disabled") return zh.agentSelector.reasonDisabled;
  if (reason === "no-workspace") return zh.agentSelector.reasonNoWorkspace;
  if (reason === "invalid") return zh.agentSelector.reasonInvalid;
  return null;
}

export function AgentSelector({
  workspace,
  onSwitchWorkspace,
}: {
  /** 当前工作区绝对路径（null = 还没选） */
  workspace: string | null;
  /** 切到另一个 agent 维护的工作区（调用方负责顺手建立绑定） */
  onSwitchWorkspace: (agentId: string, path: string) => void;
}) {
  const [view, setView] = useState<AgentProfilesView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ timer: ReturnType<typeof setTimeout> } | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await getAgentProfiles(workspace));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const agents = view?.agents ?? [];
  const active = agents.find((a) => a.active);
  const enabledAgents = agents.filter((a) => a.enabled);
  const pinnedGroup = useMemo(
    () => agents.filter((a) => isMainAgent(a) || a.pinned),
    [agents],
  );
  const regularGroup = useMemo(
    () => agents.filter((a) => a.enabled && !isMainAgent(a) && !a.pinned),
    [agents],
  );
  const disabledGroup = useMemo(
    () => agents.filter((a) => !a.enabled && !isMainAgent(a) && !a.pinned),
    [agents],
  );

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await reload();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const selectAgent = useCallback(
    (entry: AgentProfileEntry) => {
      const blocked = blockMessage(entry);
      if (blocked) {
        // 不做无声切走：把「为什么切不过去」说出来
        setHint(t(zh.agentSelector.cannotSwitch, { name: entry.name, reason: blocked }));
        return;
      }
      if (entry.active) {
        setOpen(false);
        return;
      }
      setHint(null);
      setOpen(false);
      onSwitchWorkspace(entry.id, entry.workspaceDir as string);
    },
    [onSwitchWorkspace],
  );

  const toggleEnabled = useCallback(
    (entry: AgentProfileEntry, next: boolean) => {
      void act(() => setAgentEnabled(entry.id, next));
    },
    [act],
  );

  const togglePin = useCallback(
    (entry: AgentProfileEntry) => {
      if (isMainAgent(entry)) return;
      void act(() => setAgentPinned(entry.id, !entry.pinned));
    },
    [act],
  );

  const pressHandlers = (entry: AgentProfileEntry) => ({
    onMouseDown: () => {
      const timer = setTimeout(() => {
        pressRef.current = null;
        togglePin(entry);
      }, 600);
      pressRef.current = { timer };
    },
    onMouseUp: () => {
      if (pressRef.current) {
        clearTimeout(pressRef.current.timer);
        pressRef.current = null;
      }
    },
    onMouseLeave: () => {
      if (pressRef.current) {
        clearTimeout(pressRef.current.timer);
        pressRef.current = null;
      }
    },
  });

  const renderRow = (entry: AgentProfileEntry) => {
    const blocked = blockMessage(entry);
    return (
      <div
        key={entry.id}
        data-agent-option={entry.id}
        data-agent-enabled={entry.enabled ? "true" : "false"}
        data-agent-active={entry.active ? "true" : "false"}
        data-agent-switchable={blocked ? "false" : "true"}
        role="option"
        aria-selected={entry.active}
        className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left ${
          blocked ? "cursor-default opacity-80" : "cursor-pointer hover:bg-accent"
        }`}
        onClick={() => selectAgent(entry)}
        title={
          isMainAgent(entry)
            ? zh.agentSelector.defaultPinned
            : entry.pinned
              ? zh.agentSelector.longPressToUnpin
              : zh.agentSelector.longPressToPin
        }
        {...pressHandlers(entry)}
      >
        <span
          className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: entry.enabled ? STATUS_COLOR[entry.startupStatus] : STATUS_COLOR.disabled,
          }}
          aria-hidden
        />
        <Bot size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-sm">{entry.name}</span>
            {(isMainAgent(entry) || entry.pinned) && (
              <Pin size={11} className="shrink-0 text-muted-foreground" aria-label={zh.agentSelector.pinned} />
            )}
            {entry.active && <Check size={13} className="shrink-0 text-[var(--color-success)]" aria-hidden />}
            {(!entry.enabled || entry.startupStatus === "failed") && (
              <span
                className="shrink-0 text-[10px]"
                style={{
                  color:
                    entry.startupStatus === "failed"
                      ? "var(--color-error)"
                      : "var(--color-text-tertiary)",
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
          {/* QwenPaw 的这一行是 `ID: xxx`；我们把「它维护哪个目录」一起放进来 —— 切的就是这个目录 */}
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {entry.workspaceDir
              ? t(zh.agentSelector.workspaceLine, { path: entry.workspaceDir })
              : zh.agentSelector.noWorkspaceLine}
            {` · ${t(zh.agentSelector.idLine, { id: entry.id })}`}
          </span>
        </span>
        {!isMainAgent(entry) && (
          <button
            type="button"
            data-agent-toggle={entry.id}
            aria-label={
              entry.enabled
                ? t(zh.agentSelector.disable, { name: entry.name })
                : t(zh.agentSelector.enable, { name: entry.name })
            }
            disabled={busy}
            className="mt-0.5 shrink-0 rounded p-1 hover:bg-accent"
            onClick={(event) => {
              event.stopPropagation();
              toggleEnabled(entry, !entry.enabled);
            }}
          >
            {entry.enabled ? <Power size={14} /> : <PowerOff size={14} />}
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative flex-shrink-0 border-b border-border p-3" data-agent-selector>
      <span className="text-[11px] text-muted-foreground">
        {zh.agentSelector.currentWorkspace}
        {enabledAgents.length > 0 && (
          <span className="ml-1 text-muted-foreground/70">{`(${enabledAgents.length})`}</span>
        )}
      </span>

      <button
        type="button"
        data-agent-selector-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={zh.agentSelector.selectAgent}
        onClick={() => setOpen((v) => !v)}
        className="mt-1 flex w-full items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-sm"
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: active?.enabled ? STATUS_COLOR[active.startupStatus] : STATUS_COLOR.disabled,
          }}
          aria-hidden
        />
        <Bot size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate" data-agent-selector-active>
          {active ? active.name : zh.agentSelector.unbound}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {(error || hint) && (
        <p
          className="mt-1 text-[11px]"
          style={{ color: error ? "var(--color-error)" : "var(--color-warning)" }}
          {...(error ? { "data-agent-selector-error": "" } : { "data-agent-selector-hint": "" })}
        >
          {error ?? hint}
        </p>
      )}

      {open && (
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
              <p className="px-2 pt-1 text-[10px] text-muted-foreground">{zh.agentSelector.pinnedGroup}</p>
              {pinnedGroup.map(renderRow)}
            </>
          )}

          {regularGroup.length > 0 && (
            <>
              <p className="px-2 pt-2 text-[10px] text-muted-foreground">{zh.agentSelector.otherGroup}</p>
              {regularGroup.map(renderRow)}
            </>
          )}

          {disabledGroup.length > 0 && (
            <>
              <button
                type="button"
                data-agent-selector-disabled-toggle
                aria-expanded={disabledOpen}
                className="mt-2 flex w-full items-center justify-between px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                onClick={() => setDisabledOpen((v) => !v)}
              >
                <span>{t(zh.agentSelector.disabledGroup, { count: disabledGroup.length })}</span>
                <ChevronDown
                  size={12}
                  className={disabledOpen ? "rotate-180 transition-transform" : "transition-transform"}
                />
              </button>
              {disabledOpen && disabledGroup.map(renderRow)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AgentSelector;