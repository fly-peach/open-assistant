"use client";

/**
 * 智能体配置页（路由 `/agents/[id]`，任务 5.2）。
 *
 * 覆盖 specs/agent-registry「Agent 的配置项」：人设 / 模型 / 工具白名单 /
 * 审批级别 / 同侪开关 / 可联系名单，外加技能列表（渐进披露：只展示名称与描述）。
 * 保存走 `PATCH /agents/{id}`，改动在下一轮对话生效（由后端按 agent_id 重新解析实例）。
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Loader2, Save, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import zh, { t } from "@/i18n/zh";
import { updateAgent, type AgentConfig } from "@/lib/agentsApi";
import { useAgent } from "@/app/hooks/useAgents";
import { useModelsOverview } from "@/app/hooks/useModels";
import { groupModelsByProvider } from "@/app/components/models/ModelPicker";
import { VisionBadge } from "@/app/components/models/VisionBadge";
import { ChannelSection } from "@/app/components/channels/ChannelSection";
import {
  APPROVAL_LEVELS,
  approvalOptions,
  configApproval,
  configToolState,
  formatContacts,
  modelPayload,
  modelSelectValue,
  parseContacts,
  toolOptions,
  toolsPayload,
} from "@/app/utils/agentConfig";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Radix Select 不接受空字符串 value，所以「跟随全局默认」用这个哨兵值表示，
 * 提交前再换回空串（`modelPayload("")` → null）。
 */
const INHERIT_MODEL = "__inherit__";

export default function AgentConfigPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : null;
  const { data, error, isLoading, mutate } = useAgent(id);
  // 可选模型清单（供应商 + 模型）：模型字段从这里挑，而不是手打 id
  const models = useModelsOverview();

  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");
  const [tools, setTools] = useState<Record<string, boolean>>({});
  const [approval, setApproval] = useState("");
  const [sibling, setSibling] = useState(false);
  const [contacts, setContacts] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 数据到达后填充表单（只填一次，避免覆盖用户正在编辑的内容）。
  useEffect(() => {
    if (!data || loaded) return;
    setName(data.name);
    setPersona(data.persona);
    setModel(modelSelectValue(data.config));
    setTools(configToolState(data.config));
    setApproval(configApproval(data.config));
    setSibling(data.config.allowSiblingInteraction === true);
    setContacts(formatContacts(data.config.contactableAgents));
    setLoaded(true);
  }, [data, loaded]);

  const toolChoices = useMemo(() => toolOptions(tools), [tools]);
  const approvalChoices = useMemo(() => approvalOptions(approval), [approval]);

  /** 模型下拉的分组数据（供应商 → 模型），可选项即「对话页能选的那些」 */
  const modelGroups = useMemo(
    () => groupModelsByProvider(models.data?.models ?? []),
    [models.data]
  );
  const modelsReady = !models.isLoading && !models.error;
  /** 触发器上显示的名字：从清单里找，找不到就退回配置里写的 id（老配置可能不在清单里） */
  const modelLabel = useMemo(() => {
    if (!model) return "";
    const separator = model.indexOf("::");
    if (separator <= 0) return model;
    const providerId = model.slice(0, separator);
    const modelId = model.slice(separator + 2);
    return (
      models.data?.models.find((item) => item.providerId === providerId && item.id === modelId)?.name ??
      modelId
    );
  }, [model, models.data]);

  const toggleTool = (group: string) => {
    setTools((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const onSave = async () => {
    if (!id || !data) return;
    setSaving(true);
    try {
      const config: AgentConfig = {
        ...data.config,
        model: modelPayload(model, data.config),
        tools: toolsPayload(tools),
        approval: approval || undefined,
        allowSiblingInteraction: sibling,
        contactableAgents: parseContacts(contacts),
      };
      if (!approval) delete config.approval;
      await updateAgent(id, { name: name.trim() || id, persona, config });
      toast.success(zh.agents.saved);
      await mutate();
    } catch (err) {
      toast.error(t(zh.agents.saveFailed, { error: messageOf(err) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="h-full overflow-auto p-6"
      data-agent-config-page
      data-agent-id={id ?? ""}
    >
      <Link
        href="/agents"
        prefetch={false}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        data-agent-back
      >
        <ArrowLeft size={13} />
        {zh.agents.backToList}
      </Link>

      <header className="mt-2 flex items-center gap-2">
        <h1 className="text-lg font-semibold">
          {data?.name ?? id ?? zh.agents.title}
        </h1>
        {id && <code className="text-xs text-muted-foreground">{id}</code>}
        <Link
          href={`/agents/${encodeURIComponent(id ?? "")}/memory`}
          prefetch={false}
          className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
          data-agent-memory-link
        >
          <BookOpen size={13} />
          {zh.agents.openMemory}
        </Link>
        {/* 团队（子 agent）管理是同级子路由，不是这一页的 tab（任务 2.1 的入口） */}
        <Link
          href={`/agents/${encodeURIComponent(id ?? "")}/team`}
          prefetch={false}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          data-agent-team-link
        >
          <Users size={13} />
          {zh.team.linkFromAgent}
        </Link>
      </header>

      {/* 团队变更的生效边界（任务 6.5）：如实说明，不承诺「立刻生效」 */}
      <p className="mt-2 max-w-3xl text-[11px] text-muted-foreground" data-agent-team-hint>
        {zh.team.agentPageHint}
      </p>

      {error && (
        <p
          className="mt-3 rounded-md border border-destructive/40 bg-card p-3 text-sm text-destructive"
          data-agent-config-error
        >
          {t(zh.agents.detailFailed, { error: messageOf(error) })}
        </p>
      )}
      {!error && isLoading && (
        <p className="mt-3 text-sm text-muted-foreground">{zh.common.loading}</p>
      )}

      {data && (
        <div className="mt-4 grid gap-4">
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-base font-semibold">{zh.agents.personaTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{zh.agents.personaHint}</p>
            {!persona && (
              <p
                className="mt-2 text-xs text-[var(--color-warning)]"
                data-agent-persona-missing
              >
                {zh.agents.personaMissing}
              </p>
            )}
            <Textarea
              className="mt-2"
              rows={10}
              data-agent-persona
              aria-label={zh.agents.personaTitle}
              placeholder={zh.agents.personaPlaceholder}
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
            />
          </section>

          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-base font-semibold">{zh.agents.configTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{zh.agents.configHint}</p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="agent-model">{zh.agents.modelLabel}</Label>
                {/*
                  模型从「可选清单」里挑（供应商 + 模型），而不是手打 id：
                  手打无法表达「哪个供应商」，同一个 id 在不同端点上指向的东西不一样
                  （见 utils/agentConfig.ts 的 modelPayload 注释）。
                */}
                <Select
                  value={model}
                  onValueChange={(next) => setModel(next === INHERIT_MODEL ? "" : next)}
                  disabled={!modelsReady}
                >
                  <SelectTrigger id="agent-model" data-agent-model className="h-9 text-sm">
                    <SelectValue placeholder={zh.agents.modelPlaceholder}>
                      {modelLabel || zh.agents.modelPlaceholder}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {/* Radix 不允许空字符串 value，用哨兵表示「跟随全局默认」 */}
                    <SelectItem value={INHERIT_MODEL}>{zh.agents.modelPlaceholder}</SelectItem>
                    {modelGroups.map((group) => (
                      <SelectGroup key={group.providerId}>
                        <SelectLabel className="text-[11px] font-normal text-muted-foreground">
                          {group.providerName}
                        </SelectLabel>
                        {group.models.map((item) => (
                          <SelectItem
                            key={`${group.providerId}::${item.id}`}
                            value={`${group.providerId}::${item.id}`}
                          >
                            <span className="inline-flex items-center gap-2">
                              {item.name}
                              <VisionBadge vision={item.vision} source={item.visionSource} compact />
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {modelsReady ? zh.agents.modelHint : zh.agents.modelLoadFailed}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-approval">{zh.agents.approvalLabel}</Label>
                <select
                  id="agent-approval"
                  data-agent-approval
                  value={approval}
                  onChange={(event) => setApproval(event.target.value)}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">{zh.agents.approvalUnset}</option>
                  {approvalChoices.map((level) => (
                    <option
                      key={level}
                      value={level}
                    >
                      {level}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  {zh.agents.approvalHint}
                  {approval && !(APPROVAL_LEVELS as readonly string[]).includes(approval)
                    ? ` · ${t(zh.agents.approvalCurrent, { value: approval })}`
                    : ""}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium">{zh.agents.toolsLabel}</p>
              <p className="text-xs text-muted-foreground">{zh.agents.toolsHint}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {toolChoices.map((group) => (
                  <label
                    key={group}
                    data-agent-tool={group}
                    data-agent-tool-enabled={tools[group] ? "true" : "false"}
                    className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={tools[group] === true}
                      onChange={() => toggleTool(group)}
                      data-agent-tool-checkbox={group}
                    />
                    {(zh.agents.toolGroup as Record<string, string>)[group] ?? group}
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  data-agent-sibling
                  checked={sibling}
                  onChange={(event) => setSibling(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {zh.agents.siblingLabel}
                  <span className="block text-xs text-muted-foreground">
                    {zh.agents.siblingHint}
                  </span>
                </span>
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="agent-contacts">{zh.agents.contactsLabel}</Label>
                <Input
                  id="agent-contacts"
                  data-agent-contacts
                  value={contacts}
                  placeholder={zh.agents.contactsPlaceholder}
                  onChange={(event) => setContacts(event.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {zh.agents.contactsHint}
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void onSave()}
                disabled={saving}
                data-agent-save
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {saving ? zh.agents.saving : zh.agents.save}
              </Button>
            </div>
          </section>

          {/* 频道（design D13）：频道归属 agent 定义，所以配置放在这一页而不是工作区页 */}
          <ChannelSection agentId={data.id} />

          <section className="rounded-md border border-border bg-card p-4" data-agent-skills>
            <h2 className="text-base font-semibold">{zh.agents.skillsTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{zh.agents.skillsHint}</p>
            {data.skills.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{zh.agents.skillsEmpty}</p>
            ) : (
              <ul className="mt-2 grid gap-1.5">
                {data.skills.map((skill) => (
                  <li
                    key={skill.name}
                    data-agent-skill={skill.name}
                    className="text-xs"
                  >
                    <span className="font-medium">{skill.name}</span>
                    <span className="ml-2 text-muted-foreground">{skill.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-base font-semibold">{zh.agents.memoryTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{zh.agents.memoryHint}</p>
            <pre
              className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 text-xs"
              data-agent-memory-preview
            >
              {data.memory || zh.memory.empty}
            </pre>
            <Link
              href={`/agents/${encodeURIComponent(id ?? "")}/memory`}
              prefetch={false}
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              data-agent-memory-link-2
            >
              <BookOpen size={13} />
              {zh.agents.openMemory}
            </Link>
          </section>
        </div>
      )}
    </div>
  );
}