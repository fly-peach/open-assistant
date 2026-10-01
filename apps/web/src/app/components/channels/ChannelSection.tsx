"use client";

/**
 * 「智能体配置页」里的频道区块（tasks 13.21–13.27 的核心）。
 *
 * 为什么长在智能体配置页里：**频道归属 agent 定义**（design D13）——
 * 「这个助手用什么渠道和我说话」是它身份的一部分，所以配置跟人设 / 模型 / 工具放在同一页。
 *
 * 表单**按字段定义自动渲染**（`ChannelField` 带 type），所以以后加频道只加后端字段，
 * 这个组件不用改。凭据字段只回掩码；空着提交 = 不动原值，点「清除」才清。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  deleteAgentChannel,
  listAgentChannels,
  saveAgentChannel,
  type ChannelField,
  type ChannelView,
} from "@/lib/channelsApi";
import zh, { t } from "@/i18n/zh";

interface Draft {
  config: Record<string, string | number | boolean>;
  /** 只放用户**改过**的凭据；空串表示清除 */
  secrets: Record<string, string>;
  enabled: boolean;
}

function draftOf(view: ChannelView): Draft {
  return { config: { ...view.config }, secrets: {}, enabled: view.enabled };
}

function FieldControl({
  field,
  mask,
  value,
  onChange,
}: {
  field: ChannelField;
  /** 该凭据字段的掩码（非凭据时为 undefined） */
  mask?: string;
  value: string | number | boolean | undefined;
  onChange: (next: string | number | boolean) => void;
}) {
  const id = `channel-field-${field.key}`;
  if (field.type === "switch") {
    return (
      <div className="flex items-center gap-2" data-channel-field={field.key}>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(next) => onChange(next)}
        />
        <Label htmlFor={id} className="text-xs">
          {field.label}
        </Label>
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id} className="text-xs">
          {field.label}
        </Label>
        <select
          id={id}
          data-channel-field={field.key}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {field.label}
        {field.required && <span className="ml-1 text-[var(--color-error)]">*</span>}
      </Label>
      <Input
        id={id}
        data-channel-field={field.key}
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
        value={field.secret ? String(value ?? "") : String(value ?? "")}
        placeholder={field.secret ? mask || zh.channels.secretNotSet : undefined}
        onChange={(event) =>
          onChange(field.type === "number" ? Number(event.target.value) : event.target.value)
        }
      />
      {field.help && <p className="text-[11px] text-muted-foreground">{field.help}</p>}
    </div>
  );
}

export function ChannelSection({ agentId }: { agentId: string }) {
  const [list, setList] = useState<{
    configured: ChannelView[];
    available: ChannelView[];
    fields: Record<string, ChannelField[]>;
  }>({ configured: [], available: [], fields: {} });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await listAgentChannels(agentId);
      setList({ configured: data.configured, available: data.available, fields: data.fields });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allViews = useMemo(
    () => [...list.configured, ...list.available],
    [list.configured, list.available],
  );
  const viewOf = useCallback((key: string) => allViews.find((v) => v.key === key), [allViews]);
  const draftFor = useCallback(
    (key: string): Draft => drafts[key] ?? (viewOf(key) ? draftOf(viewOf(key)!) : { config: {}, secrets: {}, enabled: false }),
    [drafts, viewOf],
  );

  const patchDraft = useCallback((key: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const base = prev[key] ?? (viewOf(key) ? draftOf(viewOf(key)!) : { config: {}, secrets: {}, enabled: false });
      return { ...prev, [key]: { ...base, ...patch } };
    });
  }, [viewOf]);

  const submit = useCallback(
    async (key: string, nextEnabled?: boolean) => {
      const draft = draftFor(key);
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const view = await saveAgentChannel(agentId, key, {
          enabled: nextEnabled ?? draft.enabled,
          config: draft.config,
          secrets: draft.secrets,
        });
        setDrafts((prev) => ({ ...prev, [key]: draftOf(view) }));
        await reload();
        setNotice(t(zh.channels.savedNotice, { name: view.label }));
      } catch (err) {
        // ⚠️ 顺序很重要：先 reload 再报错。reload 成功时会 setError(null)，
        // 反过来的话错误提示会被冲掉 —— 用户只看到开关弹回去，不知道为什么。
        //
        // 失败必须把开关拨回去：onCheckedChange 已经先把本地 draft 置成 true 了，
        // 不回滚的话界面显示「已启用」而库里是停用，两边不一致（用户会以为生效了）。
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        await reload();
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId, draftFor, reload],
  );

  const add = useCallback(
    async (key: string) => {
      setBusy(true);
      setError(null);
      try {
        await saveAgentChannel(agentId, key, { enabled: false, config: {} });
        await reload();
        setExpanded(key);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId, reload],
  );

  const remove = useCallback(
    async (key: string) => {
      setBusy(true);
      setError(null);
      try {
        await deleteAgentChannel(agentId, key);
        await reload();
        setExpanded(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId, reload],
  );

  const renderRow = (view: ChannelView, configured: boolean) => {
    const open = expanded === view.key;
    const draft = draftFor(view.key);
    const fields = list.fields[view.key] ?? [];
    const missingLabels = view.missing
      .map((key) => fields.find((f) => f.key === key)?.label ?? key)
      .join("、");

    return (
      <div
        key={view.key}
        data-channel={view.key}
        data-channel-enabled={view.enabled ? "true" : "false"}
        className="rounded-md border border-border-light p-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor: view.enabled ? "var(--color-success)" : "var(--color-text-tertiary)",
              }}
              aria-hidden
            />
            <span className="truncate text-sm font-medium">{view.label}</span>
            <span className="shrink-0 rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {view.builtin ? zh.channels.builtinTag : zh.channels.customTag}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {configured && (
              <>
                <Switch
                  data-channel-toggle={view.key}
                  aria-label={t(zh.channels.toggleAria, { name: view.label })}
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(next) => {
                    patchDraft(view.key, { enabled: next });
                    void submit(view.key, next);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-channel-expand={view.key}
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : view.key)}
                >
                  {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {open ? zh.channels.collapse : zh.channels.configure}
                </Button>
              </>
            )}
            {!configured && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-channel-add={view.key}
                disabled={busy}
                onClick={() => void add(view.key)}
              >
                <Plus size={14} className="mr-1" />
                {zh.channels.add}
              </Button>
            )}
          </div>
        </div>

        <p className="mt-1 text-[11px] text-muted-foreground">
          {zh.channels.prefixLabel}：{String(draft.config["bot_prefix"] ?? "").trim() || zh.channels.notSet}
        </p>

        {configured && view.missing.length > 0 && (
          <p className="mt-1 text-[11px] text-[var(--color-warning)]" data-channel-missing={view.key}>
            {t(zh.channels.missingHint, { fields: missingLabels })}
          </p>
        )}

        {open && configured && (
          <div className="mt-3 space-y-3 border-t border-border-light pt-3">
            {fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                {...(field.secret ? { mask: view.secrets[field.key] ?? "" } : {})}
                value={
                  field.secret
                    ? (draft.secrets[field.key] ?? "")
                    : draft.config[field.key]
                }
                onChange={(next) => {
                  if (field.secret) {
                    patchDraft(view.key, { secrets: { ...draft.secrets, [field.key]: String(next) } });
                  } else {
                    patchDraft(view.key, { config: { ...draft.config, [field.key]: next } });
                  }
                }}
              />
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" data-channel-save={view.key} disabled={busy} onClick={() => void submit(view.key)}>
                {zh.channels.save}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-channel-delete={view.key}
                disabled={busy}
                onClick={() => void remove(view.key)}
              >
                {zh.channels.remove}
              </Button>
              {view.qrcode && (
                <span className="text-[11px] text-muted-foreground">{zh.channels.qrcodeHint}</span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="rounded-md border border-border bg-card p-4" data-agent-channels>
      <h2 className="text-base font-semibold">{zh.channels.title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{zh.channels.hint}</p>

      {error && (
        <p className="mt-2 text-xs text-[var(--color-error)]" data-channels-error>
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mt-2 text-xs text-[var(--color-success)]" data-channels-notice>
          {notice}
        </p>
      )}

      <h3 className="mt-3 text-xs font-semibold text-muted-foreground">
        {t(zh.channels.configuredTitle, { count: list.configured.length })}
      </h3>
      {list.configured.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground" data-channels-configured-empty>
          {zh.channels.configuredEmpty}
        </p>
      ) : (
        <div className="mt-2 grid gap-2">{list.configured.map((v) => renderRow(v, true))}</div>
      )}

      {list.available.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold text-muted-foreground">{zh.channels.availableTitle}</h3>
          <div className="mt-2 grid gap-2">{list.available.map((v) => renderRow(v, false))}</div>
        </>
      )}
    </section>
  );
}