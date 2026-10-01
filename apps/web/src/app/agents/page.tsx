"use client";

/**
 * 智能体列表页（路由 `/agents`，任务 5.1）。
 *
 * - 列出 agents 根下的全部定义；`valid=false` 的项**标注异常**而不是让整体失败；
 * - 支持新建（标识校验在前端先挡一层，权威判定在后端）；
 * - 后端未就绪时展示可读错误态（不静默成功、不留下假数据）。
 */
import Link from "next/link";
import { useCallback, useState } from "react";
import { AlertTriangle, Bot, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import zh, { t } from "@/i18n/zh";
import { createAgent, deleteAgent, type AgentSummary } from "@/lib/agentsApi";
import { findModel, type ModelsOverview } from "@/lib/modelsApi";
import { useAgents } from "@/app/hooks/useAgents";
import { useModelsOverview } from "@/app/hooks/useModels";
import { sortAgents, validateAgentId, type AgentIdError } from "@/app/utils/agentConfig";
import { VisionBadge } from "@/app/components/models/VisionBadge";

/**
 * 列表里每个 agent 用的模型（不同 agent 可以各配各的，这里一眼能看出来）。
 *
 * 三种情况分开表达，不混为一谈：
 * - 配了模型 → 显示名字（清单里查得到就显示清单名，查不到显示原始 id）；
 * - `model: null` → 「跟随全局默认」；
 * - `model` 缺字段 → 「模型未知」（配置读不出来，别谎称跟随默认）。
 */
function agentModelView(
  agent: AgentSummary,
  overview: ModelsOverview | undefined
): { text: string; title: string; vision: boolean | null; inherit: boolean; unknown: boolean } {
  if (agent.model === undefined) {
    return { text: zh.agents.modelUnknown, title: zh.agents.modelUnknownTitle, vision: null, inherit: false, unknown: true };
  }
  if (agent.model === null) {
    return { text: zh.agents.modelInherit, title: zh.agents.modelInheritTitle, vision: null, inherit: true, unknown: false };
  }
  const found = findModel(overview, agent.model.providerId, agent.model.id);
  const name = found?.name ?? agent.model.id;
  const provider = found?.providerName ?? agent.model.providerId ?? "";
  return {
    text: provider ? `${name} · ${provider}` : name,
    title: `${name}（${agent.model.id}）${provider ? ` · ${provider}` : ""}`,
    vision: found?.vision ?? null,
    inherit: false,
    unknown: false,
  };
}

function idErrorText(reason: AgentIdError): string {
  switch (reason) {
    case "empty":
      return zh.agents.idErrorEmpty;
    case "separator":
      return zh.agents.idErrorSeparator;
    case "dotdot":
      return zh.agents.idErrorDotDot;
    case "whitespace":
      return zh.agents.idErrorWhitespace;
    default:
      return zh.agents.idErrorCharset;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function AgentsPage() {
  const { data, error, isLoading, mutate } = useAgents();
  const models = useModelsOverview();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [idError, setIdError] = useState<AgentIdError>(null);
  const [submitting, setSubmitting] = useState(false);

  const onCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const reason = validateAgentId(id);
      setIdError(reason);
      if (reason) return;
      setSubmitting(true);
      try {
        await createAgent({
          id: id.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        toast.success(t(zh.agents.created, { id: id.trim() }));
        setId("");
        setName("");
        setDescription("");
        await mutate();
      } catch (err) {
        toast.error(t(zh.agents.createFailed, { error: messageOf(err) }));
      } finally {
        setSubmitting(false);
      }
    },
    [id, name, description, mutate]
  );

  const agents = data ? sortAgents(data.agents) : [];

  /** 删除一个智能体（主智能体不可删；后端会再拦一次） */
  const removeAgent = useCallback(
    async (agent: AgentSummary) => {
      if (agent.main) return;
      if (typeof window !== "undefined" && !window.confirm(t(zh.agents.deleteConfirm, { name: agent.name, id: agent.id }))) {
        return;
      }
      try {
        await deleteAgent(agent.id);
        toast.success(t(zh.agents.deleteDone, { name: agent.name }));
        await mutate();
      } catch (err) {
        toast.error(t(zh.agents.deleteFailed, { error: messageOf(err) }));
      }
    },
    [mutate]
  );

  return (
    <div
      className="h-full overflow-auto p-6"
      data-agents-page
    >
      <header className="flex items-center gap-2">
        <Bot size={18} aria-hidden />
        <h1 className="text-lg font-semibold">{zh.agents.title}</h1>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void mutate()}
          aria-label={zh.workspace.refresh}
          title={zh.workspace.refresh}
          data-agents-refresh
        >
          <RefreshCw size={14} />
        </Button>
      </header>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{zh.agents.hint}</p>

      <section
        className="mt-4 rounded-md border border-border bg-card p-4"
        data-agents-create
      >
        <h2 className="text-base font-semibold">{zh.agents.createTitle}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{zh.agents.createHint}</p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={onCreate}
        >
          <div className="space-y-1.5">
            <Label htmlFor="agent-id">{zh.agents.idLabel}</Label>
            <Input
              id="agent-id"
              data-agent-id-input
              value={id}
              placeholder={zh.agents.idPlaceholder}
              onChange={(event) => {
                setId(event.target.value);
                if (idError) setIdError(null);
              }}
            />
            {idError && (
              <p
                className="text-xs text-destructive"
                data-agent-id-error
              >
                {idErrorText(idError)}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">{zh.agents.nameLabel}</Label>
            <Input
              id="agent-name"
              data-agent-name-input
              value={name}
              placeholder={zh.agents.namePlaceholder}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="agent-description">{zh.agents.descriptionLabel}</Label>
            <Textarea
              id="agent-description"
              data-agent-description-input
              rows={2}
              value={description}
              placeholder={zh.agents.descriptionPlaceholder}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={submitting}
              data-agent-create-submit
            >
              {submitting ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
              {submitting ? zh.agents.creating : zh.agents.create}
            </Button>
          </div>
        </form>
      </section>

      <section className="mt-6">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold">{zh.agents.listTitle}</h2>
          {data?.root && (
            <span
              className="text-xs text-muted-foreground"
              data-agents-root
              title={data.root}
            >
              {zh.agents.rootLabel}：{data.root}
            </span>
          )}
        </div>

        {error && (
          <p
            className="mt-2 rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive"
            data-agents-error
          >
            {t(zh.agents.listFailed, { error: messageOf(error) })}
          </p>
        )}

        {!error && isLoading && (
          <p className="mt-2 text-sm text-muted-foreground">{zh.common.loading}</p>
        )}

        {!error && !isLoading && agents.length === 0 && (
          <div
            className="mt-2 rounded-md border border-dashed border-border p-4 text-center"
            data-agents-empty
          >
            <p className="text-sm font-medium">{zh.agents.empty}</p>
            <p className="mt-1 text-xs text-muted-foreground">{zh.agents.emptyHint}</p>
          </div>
        )}

        {!error && agents.length > 0 && (
          <ul
            className="mt-2 grid gap-2"
            data-agents-list
          >
            {agents.map((agent) => (
              <li
                key={agent.id}
                data-agent-item
                data-agent-id={agent.id}
                data-agent-valid={agent.valid ? "true" : "false"}
                className="rounded-md border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Link
                    href={`/agents/${encodeURIComponent(agent.id)}`}
                    prefetch={false}
                    className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    {agent.name}
                  </Link>
                  <code className="text-xs text-muted-foreground">{agent.id}</code>
                  {agent.main && (
                    <span
                      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      data-agent-main-badge
                    >
                      {zh.agents.mainBadge}
                    </span>
                  )}
                  {!agent.valid && (
                    <span
                      className="inline-flex items-center gap-1 rounded border border-[var(--color-warning)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]"
                      data-agent-issues
                    >
                      <AlertTriangle size={12} />
                      {zh.agents.invalid}
                      {agent.issues && agent.issues.length > 0
                        ? ` · ${t(zh.agents.invalidIssues, { issues: agent.issues.join("；") })}`
                        : ""}
                    </span>
                  )}
                  <Link
                    href={`/agents/${encodeURIComponent(agent.id)}`}
                    prefetch={false}
                    className="ml-auto text-xs text-muted-foreground"
                  >
                    {zh.agents.open}
                  </Link>
                  <button
                    type="button"
                    onClick={() => void removeAgent(agent)}
                    disabled={agent.main}
                    aria-label={agent.main ? zh.agents.mainProtected : zh.agents.deleteAction}
                    title={agent.main ? zh.agents.mainProtected : zh.agents.deleteAction}
                    data-agent-delete={agent.id}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {agent.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{agent.description}</p>
                )}
                {(() => {
                  const view = agentModelView(agent, models.data);
                  return (
                    <p
                      className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                      data-agent-model-badge
                      data-agent-model-inherit={view.inherit ? "true" : "false"}
                      title={view.title}
                    >
                      <span className="text-muted-foreground/70">{zh.agents.modelLabel}：</span>
                      <span className={view.unknown ? "text-[var(--color-warning)]" : ""}>
                        {view.text}
                      </span>
                      {!view.inherit && !view.unknown && (
                        <VisionBadge vision={view.vision} compact />
                      )}
                    </p>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}