"use client";

/**
 * 工作区面板里的「绑定状态 + 选择/更换智能体」入口（任务 5.4 / 5.5）。
 *
 * 对齐 specs/agent-binding：
 * - 展示当前绑定；未绑定时明确展示「未绑定」并解释后果（未绑定不得对话）；
 * - 换绑是**显式动作**：先给强提示（历史属于此前绑定的 agent），
 *   再让用户在「保留历史」与「归档历史」两个选项里明确选择 —— 两个选项的结果不同：
 *   保留 → 旧会话留在列表里并标注归属；归档 → 旧会话转入工作区归档区，当前列表不再显示。
 */
import { useCallback, useState } from "react";
import { AlertTriangle, Bot, Check, Loader2, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { AgentSummary, SwitchMode } from "@/lib/agentsApi";
import { putBinding } from "@/lib/agentsApi";
import { useBindingState } from "@/app/hooks/useAgents";
import zh, { t } from "@/i18n/zh";

interface AgentBindingCardProps {
  workspacePath: string;
  onBound?: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AgentBindingCard({ workspacePath, onBound }: AgentBindingCardProps) {
  const binding = useBindingState(workspacePath);
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState<AgentSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mode: SwitchMode; name: string } | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const bound = binding.state === "bound" ? binding : null;
  const switching = Boolean(bound && candidate && candidate.id !== bound.agentId);

  const apply = useCallback(
    async (mode: SwitchMode) => {
      if (!candidate) return;
      setBusy(true);
      setErrorText(null);
      try {
        await putBinding(workspacePath, candidate.id, mode);
        const name = candidate.name || candidate.id;
        setResult({ mode, name });
        toast.success(
          mode === "keep"
            ? t(zh.binding.switchedKeep, { name })
            : t(zh.binding.switchedArchive, { name })
        );
        setCandidate(null);
        setOpen(false);
        binding.reload();
        onBound?.();
      } catch (err) {
        const message = t(zh.binding.bindFailed, { error: messageOf(err) });
        setErrorText(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [candidate, workspacePath, binding, onBound]
  );

  /** 未绑定 / 选中同一个 agent：没有历史归属问题，直接以 keep 生效。 */
  const applyDirect = useCallback(
    async (agent: AgentSummary) => {
      setBusy(true);
      setErrorText(null);
      try {
        await putBinding(workspacePath, agent.id, "keep");
        const name = agent.name || agent.id;
        setResult({ mode: "keep", name });
        toast.success(t(zh.binding.boundTo, { name }));
        setCandidate(null);
        setOpen(false);
        binding.reload();
        onBound?.();
      } catch (err) {
        const message = t(zh.binding.bindFailed, { error: messageOf(err) });
        setErrorText(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [workspacePath, binding, onBound]
  );

  const choose = useCallback(
    (agent: AgentSummary) => {
      setErrorText(null);
      setCandidate(agent);
      if (!bound || bound.agentId === agent.id) {
        void applyDirect(agent);
      }
    },
    [bound, applyDirect]
  );

  return (
    <div
      className="rounded-md border border-border bg-[var(--color-surface)] p-2 text-xs"
      data-agent-binding-card
      data-binding-state={binding.state}
      data-binding-agent-id={binding.agentId ?? ""}
    >
      <p className="flex items-center gap-1.5 font-medium">
        {bound ? <Link2 size={13} /> : <Unlink size={13} />}
        {zh.binding.title}
        <span className="ml-auto text-[11px] text-[var(--color-text-secondary)]">
          {bound ? zh.binding.bound : zh.binding.none}
        </span>
      </p>

      {bound && (
        <p
          className="mt-1 text-[11px] text-[var(--color-text-secondary)]"
          data-binding-current
          title={`${bound.agentId}`}
        >
          {t(zh.binding.boundTo, { name: bound.agentName })}
        </p>
      )}

      {binding.state === "none" && (
        <p
          className="mt-1 flex items-start gap-1 text-[11px] text-[var(--color-warning)]"
          data-binding-none-hint
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{zh.binding.noneHint}</span>
        </p>
      )}

      {binding.state === "missing-agent" && (
        <p
          className="mt-1 flex items-start gap-1 text-[11px] text-[var(--color-warning)]"
          data-binding-absent-hint
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{t(zh.binding.absentHint, { id: binding.agentId ?? "" })}</span>
        </p>
      )}

      {binding.state === "unknown" && (
        <p
          className="mt-1 text-[11px] text-[var(--color-text-secondary)]"
          data-binding-unknown-hint
        >
          {t(zh.binding.unknown, {
            error: binding.error instanceof Error ? binding.error.message : "",
          })}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={() => {
            setOpen((prev) => !prev);
            setCandidate(null);
            setErrorText(null);
          }}
          data-binding-select
        >
          <Bot size={12} />
          {bound ? zh.binding.change : zh.binding.select}
        </Button>
        {busy && <Loader2 size={12} className="animate-spin" />}
      </div>

      {open && (
        <div
          className="mt-2 rounded border border-border bg-background p-2"
          data-binding-chooser
        >
          <p className="text-[11px] font-medium">{zh.binding.chooseTitle}</p>
          <p className="text-[11px] text-[var(--color-text-secondary)]">
            {zh.binding.chooseHint}
          </p>

          {binding.agents.length === 0 ? (
            <p
              className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]"
              data-binding-choose-empty
            >
              {binding.isLoading ? zh.common.loading : zh.binding.chooseEmpty}
            </p>
          ) : (
            <ul className="mt-1.5 grid gap-1">
              {binding.agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => choose(agent)}
                    disabled={busy || !agent.valid}
                    data-binding-option
                    data-agent-id={agent.id}
                    data-agent-valid={agent.valid ? "true" : "false"}
                    className="flex w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-left text-[11px] hover:bg-[var(--color-surface)] disabled:opacity-50"
                  >
                    {bound?.agentId === agent.id ? (
                      <Check size={12} />
                    ) : (
                      <Bot size={12} />
                    )}
                    <span className="font-medium">{agent.name}</span>
                    <code className="text-[10px] text-[var(--color-text-secondary)]">
                      {agent.id}
                    </code>
                    {!agent.valid && (
                      <span className="ml-auto text-[10px] text-[var(--color-warning)]">
                        {zh.agents.invalid}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {switching && candidate && bound && (
            <div
              className="mt-2 rounded border border-[var(--color-warning)] p-2"
              data-binding-confirm
              data-binding-from={bound.agentId ?? ""}
              data-binding-to={candidate.id}
            >
              <p className="flex items-start gap-1 text-[11px] text-[var(--color-warning)]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  {t(zh.binding.confirmWarning, {
                    from: bound.agentName,
                    to: candidate.name,
                  })}
                </span>
              </p>
              {/* 两个选项的结果不同：说明 + 按钮文案 + 事后状态行都不同 */}
              <p
                className="mt-1.5 text-[11px]"
                data-binding-option-desc="keep"
              >
                {t(zh.binding.keepLine, {
                  desc: t(zh.binding.keepDesc, { from: bound.agentName, to: candidate.name }),
                })}
              </p>
              <p
                className="mt-1 text-[11px]"
                data-binding-option-desc="archive"
              >
                {t(zh.binding.archiveLine, {
                  desc: t(zh.binding.archiveDesc, {
                    from: bound.agentName,
                    to: candidate.name,
                  }),
                })}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply("keep")}
                  data-binding-confirm-keep
                  className="rounded bg-[var(--color-primary)] px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
                >
                  {busy ? zh.binding.binding : zh.binding.confirmKeep}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void apply("archive")}
                  data-binding-confirm-archive
                  className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-50"
                >
                  {busy ? zh.binding.binding : zh.binding.confirmArchive}
                </button>
                <button
                  type="button"
                  onClick={() => setCandidate(null)}
                  className="rounded border border-border px-2 py-0.5 text-[11px]"
                  data-binding-confirm-cancel
                >
                  {zh.binding.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <p
          className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]"
          data-binding-result
          data-binding-result-mode={result.mode}
        >
          {result.mode === "keep"
            ? t(zh.binding.switchedKeep, { name: result.name })
            : t(zh.binding.switchedArchive, { name: result.name })}
        </p>
      )}

      {errorText && (
        <p
          className="mt-1.5 text-[11px] text-destructive"
          data-binding-error
        >
          {errorText}
        </p>
      )}
    </div>
  );
}

export default AgentBindingCard;