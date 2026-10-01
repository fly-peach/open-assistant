"use client";

/**
 * 智能体技能面板（对齐 specs/agent-skills 与 design D8）。
 *
 * - 列表是**生效技能**：共享池（继承）+ agent 私有，同名私有优先并标注「覆盖同名共享技能」；
 * - 点技能名 → 弹窗看 **SKILL.md 正文**（渐进披露：正文不随运行注入）；
 * - 每个技能可单独启用 / 关闭（写进该 agent 的 `disabledSkills`，只影响自己）；
 * - 私有技能可删除；共享技能删不掉（只能关）；
 * - 「新增私有技能」写 `<agent>/skills/<name>/SKILL.md`；「从文件夹导入」整份复制一个技能目录。
 */
import { useCallback, useRef, useState } from "react";
import { FolderInput, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";
import {
  createAgentSkill,
  deleteAgentSkill,
  getAgentSkillContent,
  setAgentSkillEnabled,
  uploadAgentSkill,
  type AgentSkill,
  type AgentSkillDetail,
} from "@/lib/agentsApi";

interface AgentSkillsSectionProps {
  agentId: string;
  skills: AgentSkill[];
  onChanged: () => void;
  /** 由外层 Expander 提供标题与外框时置 true */
  bare?: boolean;
}

export function AgentSkillsSection({ agentId, skills, onChanged, bare = false }: AgentSkillsSectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [uploadShared, setUploadShared] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // —— 弹窗看 SKILL.md ——
  const [viewing, setViewing] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentSkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openDetail = useCallback(
    async (skill: AgentSkill) => {
      setViewing(skill.name);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        setDetail(await getAgentSkillContent(agentId, skill.name));
      } catch (err) {
        setDetailError(t(zh.agents.skillsLoadFailed, { error: (err as Error).message }));
      } finally {
        setDetailLoading(false);
      }
    },
    [agentId]
  );

  const toggle = async (skill: AgentSkill, enabled: boolean) => {
    setBusy(skill.name);
    try {
      await setAgentSkillEnabled(agentId, skill.name, enabled);
      onChanged();
    } catch (err) {
      toast.error(t(zh.agents.skillsToggleFailed, { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (skill: AgentSkill) => {
    if (typeof window !== "undefined" && !window.confirm(t(zh.agents.skillsDeleteConfirm, { name: skill.name }))) {
      return;
    }
    setBusy(skill.name);
    try {
      await deleteAgentSkill(agentId, skill.name);
      onChanged();
    } catch (err) {
      toast.error(t(zh.agents.skillsDeleteFailed, { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error(zh.agents.skillsNameRequired);
      return;
    }
    setCreating(true);
    try {
      await createAgentSkill(agentId, { name: trimmed, description: description.trim(), content });
      setName("");
      setDescription("");
      setContent("");
      onChanged();
    } catch (err) {
      toast.error(t(zh.agents.skillsCreateFailed, { error: (err as Error).message }));
    } finally {
      setCreating(false);
    }
  };

  const runUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    // 必须是文件夹选择（带相对路径）；单个文件直接选会让人以为「文件夹上传」
    const hasRelative = files.some(
      (file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath
    );
    if (!hasRelative) {
      toast.error(zh.agents.skillsUploadNoFolder);
      return;
    }
    setUploading(true);
    try {
      await uploadAgentSkill(agentId, files, {
        ...(uploadName.trim() ? { name: uploadName.trim() } : {}),
        target: uploadShared ? "shared" : "agent",
      });
      setUploadName("");
      setUploadShared(false);
      onChanged();
    } catch (err) {
      toast.error(t(zh.agents.skillsUploadFailed, { error: (err as Error).message }));
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className={bare ? "contents" : "rounded-md border border-border bg-card p-4"} data-agent-skills>
      {!bare && (
        <>
          <h2 className="text-base font-semibold">{zh.agents.skillsTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{zh.agents.skillsHint}</p>
        </>
      )}

      {skills.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{zh.agents.skillsEmpty}</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {skills.map((skill) => (
            <li
              key={skill.name}
              data-agent-skill={skill.name}
              data-skill-source={skill.source}
              className={cn(
                "flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs",
                skill.disabled && "opacity-60"
              )}
            >
              <button
                type="button"
                onClick={() => void openDetail(skill)}
                className="min-w-0 flex-1 text-left"
                data-skill-open={skill.name}
                title={zh.agents.skillsView}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{skill.name}</span>
                  <span
                    className={cn(
                      "rounded px-1 text-[10px]",
                      skill.source === "agent"
                        ? "bg-[#f59e0b]/12 text-[#b45309]"
                        : "bg-[var(--color-surface)] text-[var(--color-text-secondary)]"
                    )}
                  >
                    {skill.source === "agent"
                      ? zh.agents.skillsSourceAgent
                      : zh.agents.skillsSourceShared}
                  </span>
                  {skill.overridesShared && (
                    <span className="text-[10px] text-muted-foreground">
                      {zh.agents.skillsOverrides}
                    </span>
                  )}
                </span>
                <span className="block truncate text-muted-foreground" title={skill.description}>
                  {skill.description}
                </span>
              </button>

              <Switch
                checked={!skill.disabled}
                onCheckedChange={(next) => void toggle(skill, next)}
                disabled={busy === skill.name}
                aria-label={skill.disabled ? zh.agents.skillsEnable : zh.agents.skillsDisable}
                data-skill-toggle={skill.name}
              />

              {skill.source === "agent" ? (
                <button
                  type="button"
                  onClick={() => void remove(skill)}
                  disabled={busy === skill.name}
                  aria-label={zh.agents.skillsDeletePrivate}
                  title={zh.agents.skillsDeletePrivate}
                  data-skill-delete={skill.name}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                >
                  {busy === skill.name ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              ) : (
                <span className="w-[21px]" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 新增私有技能 */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium">{zh.agents.skillsCreateTitle}</summary>
        <div className="mt-2 grid gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={zh.agents.skillsNamePlaceholder}
            data-skill-new-name
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={zh.agents.skillsDescPlaceholder}
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={zh.agents.skillsContentPlaceholder}
            rows={4}
          />
          <div>
            <Button type="button" size="sm" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {zh.agents.skillsCreate}
            </Button>
          </div>
        </div>
      </details>

      {/* 上传技能文件夹 */}
      <details className="mt-2" data-skill-upload>
        <summary className="cursor-pointer text-xs font-medium">{zh.agents.skillsUploadTitle}</summary>
        <div className="mt-2 grid gap-2">
          <p className="text-[11px] text-muted-foreground">{zh.agents.skillsUploadHint}</p>
          <Input
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
            placeholder={zh.agents.skillsUploadNamePlaceholder}
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={uploadShared}
              onChange={(e) => setUploadShared(e.target.checked)}
            />
            {zh.agents.skillsUploadShared}
          </label>
          <div>
            {/* 目录选择：React 不识别该属性，用 spread 传原生属性 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              className="hidden"
              onChange={(e) => {
                void runUpload(e.target.files);
                e.target.value = "";
              }}
              data-skill-upload-input
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-skill-upload-run
            >
              {uploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FolderInput className="mr-2 h-4 w-4" />
              )}
              {uploading ? zh.agents.skillsUploading : zh.agents.skillsUploadPick}
            </Button>
          </div>
        </div>
      </details>

      {/* SKILL.md 正文弹窗 */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewing(null);
            setDetail(null);
            setDetailError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-skill-dialog>
          <DialogHeader>
            <DialogTitle data-skill-dialog-title>{detail?.name ?? viewing}</DialogTitle>
            <DialogDescription>
              {detail?.description ? `${detail.description} · ` : ""}
              {zh.agents.skillsDialogHint}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded border border-border bg-[var(--color-surface)] p-3">
            {detailLoading ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                {zh.common.loading}
              </span>
            ) : detailError ? (
              <span className="text-xs text-[var(--color-error)]">{detailError}</span>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6" data-skill-dialog-content>
                {detail?.content}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setViewing(null);
                setDetail(null);
              }}
            >
              {zh.common.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default AgentSkillsSection;