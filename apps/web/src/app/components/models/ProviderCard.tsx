"use client";

/**
 * 一个供应商的配置卡：连接信息 + 模型清单 + 连通性测试 + 远端发现。
 *
 * ## 表单的两个约定
 *
 * - **API Key 只进不出**：输入框初始为空，placeholder 显示后端给的掩码
 *   （`sk-a********mnop`）。用户不填 → 提交体里不带 `apiKey` → 后端保持原值。
 *   这样「界面不显示真 key」和「保存其它字段不会把 key 清掉」同时成立。
 * - **保存是显式的**：改完点「保存」，不做失焦自动提交 —— 供应商配置一发就是
 *   花钱的凭据，误触代价比多点一次大。
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCopy, Eye, EyeOff, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import zh, { t } from "@/i18n/zh";
import {
  addProviderModels,
  deleteProvider,
  discoverModels,
  PROVIDER_KIND_LABEL,
  setDefaultModel,
  testProvider,
  upsertProvider,
  type DiscoverResult,
  type ModelsOverview,
  type ProviderView,
} from "@/lib/modelsApi";
import { ModelRow } from "@/app/components/models/ModelRow";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ProviderCardProps {
  provider: ProviderView;
  models: ModelsOverview["models"];
  isDefaultModel: (providerId: string, modelId: string) => boolean;
  onRefresh: () => Promise<void>;
}

export function ProviderCard({
  provider,
  models,
  isDefaultModel,
  onRefresh,
}: ProviderCardProps) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [enabled, setEnabled] = useState(provider.enabled);
  const [manualModel, setManualModel] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "discover" | "remove" | "add" | null>(null);
  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  // 后端数据变化（别人的改动 / 刷新）时把表单拉回真相，避免展示陈旧值
  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setEnabled(provider.enabled);
  }, [provider.name, provider.baseUrl, provider.enabled]);

  const dirty =
    name.trim() !== provider.name ||
    baseUrl.trim() !== provider.baseUrl ||
    apiKey.trim().length > 0 ||
    enabled !== provider.enabled;

  const own = useMemo(
    () => models.filter((model) => model.providerId === provider.id),
    [models, provider.id]
  );

  async function save() {
    if (!dirty) {
      toast.info(zh.models.savedUnchanged);
      return;
    }
    setBusy("save");
    try {
      await upsertProvider({
        id: provider.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        enabled,
        // 空串 = 不提交 → 后端保持原 key（见 models/index.ts 的 isMasked 说明）
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      await onRefresh();
      toast.success(zh.models.saveDone);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    try {
      const result = await testProvider(provider.id);
      if (result.ok) {
        toast.success(
          t(zh.models.testOk, { ms: result.latencyMs, reply: result.reply?.slice(0, 40) ?? "" })
        );
      } else {
        toast.error(t(zh.models.testFail, { error: result.error ?? "" }));
      }
    } catch (err) {
      toast.error(t(zh.models.testFail, { error: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  }

  async function runDiscover() {
    setBusy("discover");
    try {
      const result = await discoverModels(provider.id);
      setDiscovered(result);
      if (!result.ok) {
        toast.error(t(zh.models.discoverFail, { error: result.error ?? "" }));
      } else if (result.added.length === 0) {
        toast.info(zh.models.discoverNone);
      } else {
        toast.success(
          t(zh.models.discoverOk, { count: result.models.length, added: result.added.length })
        );
      }
    } catch (err) {
      toast.error(t(zh.models.discoverFail, { error: messageOf(err) }));
    } finally {
      setBusy(null);
    }
  }

  async function addPicked() {
    if (picked.length === 0) return;
    setBusy("add");
    try {
      await addProviderModels(provider.id, picked);
      setPicked([]);
      setDiscovered(null);
      await onRefresh();
      toast.success(t(zh.models.addSelectedDone, { count: picked.length }));
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function addManual() {
    const id = manualModel.trim();
    if (!id) return;
    setBusy("add");
    try {
      await addProviderModels(provider.id, [id]);
      setManualModel("");
      await onRefresh();
      toast.success(t(zh.models.addSelectedDone, { count: 1 }));
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(t(zh.models.removeConfirm, { name: provider.name }))) return;
    setBusy("remove");
    try {
      await deleteProvider(provider.id);
      await onRefresh();
      toast.success(t(zh.models.removed, { name: provider.name }));
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      data-provider-card={provider.id}
    >
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{provider.name}</h3>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {PROVIDER_KIND_LABEL[provider.kind] ?? provider.kind}
        </span>
        {provider.hasApiKey && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> {provider.apiKeyMasked}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`enabled-${provider.id}`} className="text-xs text-muted-foreground">
            {zh.models.enabledLabel}
          </Label>
          <Switch
            id={`enabled-${provider.id}`}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={zh.models.enabledLabel}
          />
        </div>
      </header>

      <p className="mb-3 text-[11px] text-muted-foreground">{provider.kindHint}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`name-${provider.id}`}>{zh.models.nameLabel}</Label>
          <Input
            id={`name-${provider.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`base-${provider.id}`}>{zh.models.baseUrlLabel}</Label>
          <Input
            id={`base-${provider.id}`}
            value={baseUrl}
            placeholder={zh.models.baseUrlPlaceholder}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`key-${provider.id}`}>{zh.models.apiKeyLabel}</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`key-${provider.id}`}
              type={reveal ? "text" : "password"}
              autoComplete="off"
              value={apiKey}
              placeholder={
                provider.hasApiKey ? zh.models.apiKeyPlaceholderKeep : zh.models.apiKeyPlaceholderEmpty
              }
              onChange={(event) => setApiKey(event.target.value)}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setReveal((prev) => !prev)}
              aria-label={reveal ? zh.models.apiKeyLabel : zh.models.apiKeyLabel}
              title={zh.models.apiKeyHint}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{zh.models.apiKeyHint}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy !== null} data-provider-save>
          {busy === "save" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {busy === "save" ? zh.models.saving : zh.models.save}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void runTest()}
          disabled={busy !== null}
          data-provider-test
        >
          {busy === "test" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {busy === "test" ? zh.models.testing : zh.models.test}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void runDiscover()}
          disabled={busy !== null}
          title={zh.models.discoverHint}
          data-provider-discover
        >
          {busy === "discover" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {busy === "discover" ? zh.models.discovering : zh.models.discover}
        </Button>
        {provider.removable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            onClick={() => void remove()}
            disabled={busy !== null}
          >
            <Trash2 className="h-3 w-3" />
            {zh.models.remove}
          </Button>
        ) : (
          <span className="ml-auto text-[11px] text-muted-foreground">{zh.models.removeBuiltinHint}</span>
        )}
      </div>

      {/* 远端发现结果：默认全不选，避免一次灌进几百个模型 */}
      {discovered?.ok && discovered.models.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-2" data-discover-result>
          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {t(zh.models.discoverOk, {
                count: discovered.models.length,
                added: discovered.added.length,
              })}
            </span>
            {discovered.added.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                onClick={() => setPicked(discovered.added)}
                disabled={busy !== null}
              >
                <ClipboardCopy className="h-3 w-3" />
                {t(zh.models.addSelected, { count: discovered.added.length })}
              </Button>
            )}
          </div>
          <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
            {discovered.added.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() =>
                  setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                }
                className={
                  picked.includes(id)
                    ? "rounded border border-primary bg-primary/10 px-1.5 py-0.5 font-mono text-[11px]"
                    : "rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                }
              >
                {id}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <h4 className="text-xs font-semibold">{zh.models.modelsTitle}</h4>
          <span className="text-[11px] text-muted-foreground">{zh.models.modelsHint}</span>
        </div>

        <div className="rounded-md border border-border">
          {own.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{zh.models.modelsEmpty}</p>
          ) : (
            own.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                isDefault={isDefaultModel(provider.id, model.id)}
                onSetDefault={async (target) => {
                  try {
                    await setDefaultModel(target.providerId, target.id);
                    await onRefresh();
                    toast.success(
                      t(zh.models.defaultSetDone, {
                        provider: provider.name,
                        model: target.name,
                      })
                    );
                  } catch (err) {
                    toast.error(messageOf(err));
                  }
                }}
                onRefresh={onRefresh}
                onRemove={async (target) => {
                  try {
                    await upsertProvider({
                      id: provider.id,
                      models: provider.models.filter((id) => id !== target.id),
                    });
                    await onRefresh();
                    toast.success(t(zh.models.modelRemoved, { model: target.name }));
                  } catch (err) {
                    toast.error(messageOf(err));
                  }
                }}
              />
            ))
          )}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <Input
            value={manualModel}
            onChange={(event) => setManualModel(event.target.value)}
            placeholder={zh.models.addModelPlaceholder}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addManual();
              }
            }}
            className="h-8 max-w-xs font-mono text-xs"
            aria-label={zh.models.addModelPlaceholder}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void addManual()}
            disabled={busy !== null || manualModel.trim().length === 0}
          >
            {zh.models.addModel}
          </Button>
        </div>
      </div>
    </section>
  );
}
