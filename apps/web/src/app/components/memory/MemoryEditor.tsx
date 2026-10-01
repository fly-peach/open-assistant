"use client";

/**
 * 记忆编辑器（纯展示 + 本地草稿），供 `/memory` 与 `/agents/[id]/memory` 复用。
 *
 * 关键约束（specs/agent-registry「与项目记忆分开」）：
 * - 内容与草稿完全由调用方注入（`load` / `save` 指向不同端点）；
 * - 每个实例的草稿只存在自己的 state 里，改到一半再切分栏也不会串台；
 * - 目标变化（换工作区 / 换智能体）时按 `reloadKey` 重新拉取并重置草稿。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import zh, { t } from "@/i18n/zh";

export interface MemoryEditorProps {
  /** 分栏标识：用于 data-* 断言与文案归属。 */
  scope: string;
  title: string;
  description: string;
  targetLabel?: string;
  placeholder: string;
  /** 作用范围变化时重新加载（工作区路径 / 智能体标识）。 */
  reloadKey: string;
  load: () => Promise<string>;
  save: (content: string) => Promise<unknown>;
  /** 不可用时的说明（如未绑定智能体）：展示并禁止编辑。 */
  blockedReason?: string | null;
  loadErrorMessage: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function MemoryEditor({
  scope,
  title,
  description,
  targetLabel,
  placeholder,
  reloadKey,
  load,
  save,
  blockedReason,
  loadErrorMessage,
}: MemoryEditorProps) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // load / save 每次渲染都是新函数，用 ref 保住最新值，避免重复拉取。
  const loadRef = useRef(load);
  const saveRef = useRef(save);
  useEffect(() => {
    loadRef.current = load;
    saveRef.current = save;
  }, [load, save]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await loadRef.current();
      setContent(value);
      setOriginal(value);
      setLoadedKey(reloadKey);
    } catch (err) {
      // 读取失败不静默：清空草稿并展示可读错误（避免把上一个目标的记忆留在界面上）。
      setContent("");
      setOriginal("");
      setLoadedKey(reloadKey);
      setError(t(loadErrorMessage, { error: messageOf(err) }));
    } finally {
      setLoading(false);
    }
  }, [reloadKey, loadErrorMessage]);

  useEffect(() => {
    if (blockedReason) {
      setContent("");
      setOriginal("");
      setLoadedKey(null);
      return;
    }
    if (loadedKey === reloadKey) return;
    void reload();
  }, [reloadKey, blockedReason, loadedKey, reload]);

  const dirty = content !== original;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveRef.current(content);
      setOriginal(content);
      toast.success(zh.memory.saved);
    } catch (err) {
      toast.error(t(zh.memory.saveFailed, { error: messageOf(err) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-md border border-border bg-card p-4"
      data-memory-editor={scope}
    >
      <header className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void reload()}
          disabled={loading || Boolean(blockedReason)}
          aria-label={zh.memory.reload}
          title={zh.memory.reload}
          data-memory-reload={scope}
        >
          <RefreshCw size={14} />
        </Button>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {targetLabel && (
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          data-memory-target={scope}
        >
          {targetLabel}
        </p>
      )}

      {blockedReason ? (
        <p
          className="mt-2 rounded border border-dashed border-border p-3 text-xs text-muted-foreground"
          data-memory-blocked={scope}
        >
          {blockedReason}
        </p>
      ) : (
        <>
          <Textarea
            className="mt-2"
            rows={8}
            value={content}
            placeholder={placeholder}
            aria-label={`${title} ${zh.memory.editorLabel}`}
            onChange={(event) => setContent(event.target.value)}
            disabled={loading}
            data-memory-field={scope}
          />
          {error && (
            <p
              className="mt-2 rounded border border-destructive/40 p-2 text-xs text-destructive"
              data-memory-error={scope}
            >
              {error}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={saving || loading}
              data-memory-save={scope}
            >
              {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
              {saving ? zh.memory.saving : zh.memory.save}
            </Button>
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              data-memory-status={scope}
              data-memory-dirty={dirty ? "true" : "false"}
            >
              {dirty && <AlertTriangle size={12} />}
              {dirty ? zh.memory.dirty : ""}
            </span>
          </div>
        </>
      )}
    </section>
  );
}