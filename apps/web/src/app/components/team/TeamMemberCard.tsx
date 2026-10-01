"use client";

/**
 * 团队页里的单个子 agent 卡片：路由描述 + 系统提示词 + 工具白名单 + 模型。
 *
 * 一条硬约束（specs/subagent-team「保存非法内容被拒绝」）：
 * 这三样与正文**共用一份 `SPEC.md`**，所以它们**一起**提交（一次 `PUT` 一次原子写）。
 * 保存被后端拒绝时，把后端返回的原因渲染到 `data-team-save-error`（不能只弹 toast，
 * 否则 browser-use 断言与用户都看不到「为什么被拒绝」）。
 *
 * `skills` / `mode` 属于进阶项，放折叠区且**本轮只读**（不在这三件事的范围内）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import zh, { t } from "@/i18n/zh";
import type { SubAgentMember, SubAgentPatch, ToolCatalogGroup } from "@/lib/teamApi";
import { VisionBadge } from "@/app/components/models/VisionBadge";
import { ToolWhitelistPicker } from "@/app/components/team/ToolWhitelistPicker";
import {
  INHERIT_MODEL,
  draftsEqual,
  issuesText,
  memberDraftFrom,
  memberPayload,
  modelOptionLabel,
  normalizeToolSelection,
  toggleToolSelection,
  type MemberDraft,
  type TeamModelGroup,
} from "@/app/utils/teamConfig";

export interface TeamMemberCardProps {
  member: SubAgentMember;
  /** 可选工具目录（后端按主 agent 的 config.tools 现算）。 */
  catalog: ToolCatalogGroup[];
  /** 可选模型清单（供应商 → 模型）。 */
  modelGroups: TeamModelGroup[];
  /** 模型清单是否已就绪（没就绪时不让切换，但不清空既有值）。 */
  modelsReady: boolean;
  onSave: (patch: SubAgentPatch) => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 服务端返回的成员内容指纹：变了才允许重置本地草稿。 */
function memberSignature(member: SubAgentMember): string {
  return [
    member.name,
    member.valid ? "1" : "0",
    member.description,
    member.systemPrompt,
    member.tools === null ? "\u0000inherit" : member.tools.join("\u0000"),
    member.model ? `${member.model.providerId ?? ""}::${member.model.id}` : "\u0000none",
    member.mode,
    member.skills === null ? "\u0000inherit" : member.skills.join("\u0000"),
  ].join("\u0001");
}

function toolsKey(draft: MemberDraft): string {
  return `${draft.toolsMode}|${normalizeToolSelection(draft.tools).join("\u0000")}`;
}

export function TeamMemberCard({
  member,
  catalog,
  modelGroups,
  modelsReady,
  onSave,
}: TeamMemberCardProps) {
  const [draft, setDraft] = useState<MemberDraft>(() => memberDraftFrom(member));
  const [original, setOriginal] = useState<MemberDraft>(() => memberDraftFrom(member));
  const [loadedSignature, setLoadedSignature] = useState(() => memberSignature(member));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const draftRef = useRef(draft);
  const originalRef = useRef(original);
  useEffect(() => {
    draftRef.current = draft;
    originalRef.current = original;
  }, [draft, original]);

  // 后端数据变了（例如 mutate 之后）就重新填草稿；但**有未保存改动时不覆盖**用户正在编辑的内容。
  const signature = memberSignature(member);
  useEffect(() => {
    if (signature === loadedSignature) return;
    if (!draftsEqual(draftRef.current, originalRef.current)) return;
    const next = memberDraftFrom(member);
    setDraft(next);
    setOriginal(next);
    setLoadedSignature(signature);
  }, [signature, loadedSignature, member]);

  const dirty = !draftsEqual(draft, original);
  const descriptionDirty = draft.description !== original.description;
  const promptDirty = draft.systemPrompt !== original.systemPrompt;
  const modelDirty = draft.model !== original.model;
  const toolsDirty = toolsKey(draft) !== toolsKey(original);
  const dirtyFields = [
    descriptionDirty ? "description" : "",
    promptDirty ? "prompt" : "",
    toolsDirty ? "tools" : "",
    modelDirty ? "model" : "",
  ].filter(Boolean);

  const modelLabel = useMemo(
    () => modelOptionLabel(draft.model, modelGroups),
    [draft.model, modelGroups]
  );

  const onSaveClick = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(memberPayload(draft));
      // 保存成功即把当前草稿当作新的基线（列表刷新后还会按签名再对齐一次）。
      setOriginal(draft);
      setSavedOnce(true);
    } catch (err) {
      const message = messageOf(err);
      setSaveError(message);
      toast.error(t(zh.team.saveFailed, { error: message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      className="rounded-md border border-border bg-card p-4"
      data-team-member={member.name}
      data-team-member-valid={member.valid ? "true" : "false"}
      data-team-dirty={dirty ? "true" : "false"}
      data-team-dirty-fields={dirtyFields.join(",")}
    >
      <header className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-semibold" data-team-member-name={member.name}>
          {member.name}
        </code>
        {!member.valid && (
          <span
            className="inline-flex items-center gap-1 rounded border border-[var(--color-warning)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]"
            data-team-issues={member.name}
          >
            <AlertTriangle size={12} />
            {zh.team.invalid}
            {member.issues.length > 0
              ? ` · ${t(zh.team.invalidIssues, { issues: issuesText(member.issues) })}`
              : ""}
          </span>
        )}
        {member.issues.length > 0 && (
          <code className="text-[11px] text-muted-foreground" data-team-spec-path={member.name}>
            {member.specPath}
          </code>
        )}
        <span className="ml-auto flex items-center gap-2">
          {dirty && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-[var(--color-warning)]"
              data-team-dirty-hint={member.name}
            >
              <AlertTriangle size={11} />
              {zh.team.dirty}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={advanced}
            onClick={() => setAdvanced((prev) => !prev)}
            data-team-advanced-toggle={member.name}
          >
            {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {advanced ? zh.team.advancedHide : zh.team.advanced}
          </Button>
        </span>
      </header>

      {advanced && (
        <div
          className="mt-3 grid gap-2 rounded border border-dashed border-border p-3"
          data-team-advanced={member.name}
        >
          <div data-team-skills={member.name}>
            <p className="text-xs font-medium">{zh.team.skillsLabel}</p>
            <p className="text-[11px] text-muted-foreground">{zh.team.skillsHint}</p>
            {member.skills === null ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{zh.team.skillsInherit}</p>
            ) : member.skills.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{zh.team.skillsEmpty}</p>
            ) : (
              <ul className="mt-1 grid gap-0.5">
                {member.skills.map((skill) => (
                  <li key={skill} className="text-[11px]" data-team-skill={skill}>
                    {skill}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div data-team-mode={member.name}>
            <p className="text-xs font-medium">{zh.team.modeLabel}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {member.mode === "fork" ? zh.team.modeFork : zh.team.modeIsolated}
            </p>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-3">
        <div
          className="space-y-1.5"
          data-team-field-dirty="description"
          data-team-field-dirty-value={descriptionDirty ? "true" : "false"}
        >
          <Label htmlFor={`team-${member.name}-description`}>{zh.team.descriptionLabel}</Label>
          <Textarea
            id={`team-${member.name}-description`}
            rows={2}
            value={draft.description}
            placeholder={zh.team.descriptionPlaceholder}
            aria-label={`${member.name} ${zh.team.descriptionLabel}`}
            onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
            data-team-member-description={member.name}
          />
          <p className="text-[11px] text-muted-foreground">{zh.team.descriptionHint}</p>
          {!draft.description.trim() && (
            <p
              className="text-[11px] text-[var(--color-warning)]"
              data-team-description-empty={member.name}
            >
              {zh.team.noDescription}
            </p>
          )}
        </div>

        <div
          className="space-y-1.5"
          data-team-field-dirty="prompt"
          data-team-field-dirty-value={promptDirty ? "true" : "false"}
        >
          <Label htmlFor={`team-${member.name}-prompt`}>{zh.team.promptLabel}</Label>
          <Textarea
            id={`team-${member.name}-prompt`}
            rows={10}
            value={draft.systemPrompt}
            placeholder={zh.team.promptPlaceholder}
            aria-label={`${member.name} ${zh.team.promptLabel}`}
            onChange={(event) => setDraft((prev) => ({ ...prev, systemPrompt: event.target.value }))}
            data-team-member-prompt={member.name}
          />
          <p className="text-[11px] text-muted-foreground">{zh.team.promptHint}</p>
        </div>

        <div
          className="space-y-1.5"
          data-team-field-dirty="tools"
          data-team-field-dirty-value={toolsDirty ? "true" : "false"}
          data-team-member-tools={member.name}
        >
          <ToolWhitelistPicker
            scope={member.name}
            catalog={catalog}
            mode={draft.toolsMode}
            selected={draft.tools}
            disabled={saving}
            onModeChange={(mode) => setDraft((prev) => ({ ...prev, toolsMode: mode }))}
            onToggle={(name) =>
              setDraft((prev) => ({ ...prev, tools: toggleToolSelection(prev.tools, name) }))
            }
          />
        </div>

        <div
          className="space-y-1.5"
          data-team-field-dirty="model"
          data-team-field-dirty-value={modelDirty ? "true" : "false"}
        >
          <Label htmlFor={`team-${member.name}-model`}>{zh.team.modelLabel}</Label>
          <Select
            value={draft.model}
            onValueChange={(next) => setDraft((prev) => ({ ...prev, model: next }))}
            disabled={saving || !modelsReady}
          >
            <SelectTrigger
              id={`team-${member.name}-model`}
              className="h-9 text-sm"
              data-team-member-model={member.name}
            >
              <SelectValue placeholder={zh.team.modelInherit}>
                {modelLabel || zh.team.modelInherit}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {/* Radix 不允许空字符串 value，用哨兵表示「不写 model 键」 */}
              <SelectItem value={INHERIT_MODEL}>{zh.team.modelInherit}</SelectItem>
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
                        <VisionBadge vision={item.vision} compact />
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {modelsReady ? zh.team.modelHint : zh.team.modelLoadFailed}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void onSaveClick()} disabled={saving} data-team-save={member.name}>
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
          {saving ? zh.team.saving : zh.team.save}
        </Button>
        {savedOnce && !dirty && !saveError && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            data-team-saved={member.name}
          >
            <Check size={11} />
            {zh.team.saved}
          </span>
        )}
        {saveError && (
          <span
            className="rounded border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
            data-team-save-error={member.name}
          >
            {t(zh.team.saveRejected, { error: saveError })}
          </span>
        )}
      </div>
    </article>
  );
}
