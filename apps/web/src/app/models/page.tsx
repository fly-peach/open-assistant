"use client";

/**
 * 模型设置页（路由 `/models`）。
 *
 * ## 页面结构
 *
 * 1. 顶部说明：凭据存在哪、解析顺序、改完什么时候生效；
 * 2. 全局默认模型：一个供应商 + 模型的下拉（agent 没单独配时用它）；
 * 3. 供应商卡片列表：连接信息 + 模型清单 + 连通性测试 + 远端发现；
 * 4. 「添加自定义供应商」：任何 OpenAI 兼容端点。
 *
 * ## 与对话页的关系
 *
 * 这里配的是**能力与凭据**（有哪些模型可选）；真正「这个工作区现在用哪个」
 * 由对话页的 `ModelPicker` 决定，它写进绑定 agent 的 `config.json`。
 * 两个页面读的是同一份后端数据，所以配完不用刷新对话页。
 */
import { Suspense, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import zh, { t } from "@/i18n/zh";
import { modelKey, parseModelKey, setDefaultModel, upsertProvider } from "@/lib/modelsApi";
import { useModelsOverview } from "@/app/hooks/useModels";
import { ProviderCard } from "@/app/components/models/ProviderCard";
import { VisionBadge } from "@/app/components/models/VisionBadge";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ModelsPageInner() {
  const { data, error, isLoading, mutate } = useModelsOverview();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await mutate();
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {zh.common.loading}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-2 p-8">
        <p className="text-sm text-destructive">{t(zh.models.loadFailed, { error: messageOf(error) })}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {zh.models.retry}
        </Button>
      </div>
    );
  }

  const defaults = data.defaults;
  const defaultValue =
    defaults.providerId && defaults.modelId ? modelKey(defaults.providerId, defaults.modelId) : "";

  return (
    <div
      className="mx-auto h-full max-w-4xl space-y-6 overflow-y-auto overscroll-contain p-6"
      data-models-page
    >
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">{zh.models.title}</h1>
        <p className="text-xs text-muted-foreground">{zh.models.hint}</p>
        <p className="text-xs text-muted-foreground">{zh.models.keyStorageHint}</p>
      </header>

      {/* 全局默认：agent 没配模型时的落点 */}
      <section className="rounded-lg border border-border bg-card p-4" data-models-default>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{zh.models.defaultTitle}</h2>
          <span className="text-[11px] text-muted-foreground">{zh.models.defaultHint}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={defaultValue}
            onValueChange={async (next) => {
              const parsed = parseModelKey(next);
              if (!parsed) return;
              setBusy(true);
              try {
                await setDefaultModel(parsed.providerId, parsed.modelId);
                await refresh();
                toast.success(
                  t(zh.models.defaultSetDone, { provider: parsed.providerId, model: parsed.modelId })
                );
              } catch (err) {
                toast.error(messageOf(err));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            <SelectTrigger className="h-8 w-auto min-w-[260px] text-xs" aria-label={zh.models.defaultTitle}>
              <SelectValue placeholder={zh.models.defaultNone}>{defaultValue || zh.models.defaultNone}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {data.models.map((model) => (
                <SelectItem key={modelKey(model.providerId, model.id)} value={modelKey(model.providerId, model.id)}>
                  <span className="inline-flex items-center gap-2">
                    {model.name}
                    <span className="text-[11px] text-muted-foreground">{model.providerName}</span>
                    <VisionBadge vision={model.vision} source={model.visionSource} compact />
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">
            {defaults.providerId && defaults.modelId
              ? t(zh.models.defaultCurrent, { provider: defaults.providerId, model: defaults.modelId })
              : zh.models.defaultNone}
          </span>
        </div>
      </section>

      {/* 供应商列表 */}
      <section className="space-y-3">
        <header className="space-y-1">
          <h2 className="text-sm font-semibold">{zh.models.providersTitle}</h2>
          <p className="text-xs text-muted-foreground">{zh.models.providersHint}</p>
        </header>

        {data.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            models={data.models}
            isDefaultModel={(providerId, modelId) =>
              defaults.providerId === providerId && defaults.modelId === modelId
            }
            onRefresh={refresh}
          />
        ))}
      </section>

      {/* 自定义供应商 */}
      <section className="rounded-lg border border-dashed border-border p-4" data-models-add>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">{zh.models.addProvider}</h2>
          <span className="text-[11px] text-muted-foreground">{zh.models.addProviderHint}</span>
          {!adding && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3 w-3" />
              {zh.models.addProvider}
            </Button>
          )}
        </div>

        {adding && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="new-provider-name">{zh.models.nameLabel}</Label>
              <Input
                id="new-provider-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-provider-base">{zh.models.baseUrlLabel}</Label>
              <Input
                id="new-provider-base"
                value={newBaseUrl}
                placeholder={zh.models.baseUrlPlaceholder}
                onChange={(event) => setNewBaseUrl(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="new-provider-key">{zh.models.apiKeyLabel}</Label>
              <Input
                id="new-provider-key"
                type="password"
                autoComplete="off"
                value={newApiKey}
                onChange={(event) => setNewApiKey(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || newBaseUrl.trim().length === 0}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await upsertProvider({
                      kind: "custom",
                      name: newName.trim() || zh.models.addProvider,
                      baseUrl: newBaseUrl.trim(),
                      ...(newApiKey.trim() ? { apiKey: newApiKey.trim() } : {}),
                    });
                    setNewName("");
                    setNewBaseUrl("");
                    setNewApiKey("");
                    setAdding(false);
                    await refresh();
                    toast.success(zh.models.saveDone);
                  } catch (err) {
                    toast.error(messageOf(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {zh.models.save}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                {zh.common.cancel}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function ModelsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {zh.common.loading}
        </div>
      }
    >
      <ModelsPageInner />
    </Suspense>
  );
}
