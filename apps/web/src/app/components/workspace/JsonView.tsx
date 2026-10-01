"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import zh, { t } from "@/i18n/zh";
import { cn } from "@/lib/utils";

/**
 * JSON 结构化可读呈现（对齐 specs/file-workspace-ui「结构化文本可读呈现」）。
 *
 * 刻意不做「原始字符串堆叠」：对象 / 数组可折叠、键与值分色、按类型区分值样式。
 * 解析失败时不在这里处理 —— 由调用方（FilePreview）降级为原始文本 + 提示。
 */
function typeOf(value: unknown): "object" | "array" | "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

const VALUE_CLASS: Record<string, string> = {
  string: "text-[#047857]",
  number: "text-[#7c3aed]",
  boolean: "text-[#b45309]",
  null: "text-[var(--color-text-tertiary)]",
};

function PrimitiveValue({ value }: { value: unknown }) {
  const kind = typeOf(value);
  if (kind === "null") {
    return <span className={VALUE_CLASS.null}>null</span>;
  }
  if (kind === "string") {
    return (
      <span className={cn("break-all font-mono", VALUE_CLASS.string)}>
        &quot;{String(value)}&quot;
      </span>
    );
  }
  if (kind === "number" || kind === "boolean") {
    return (
      <span className={cn("font-mono", VALUE_CLASS[kind])}>{String(value)}</span>
    );
  }
  return <span className="font-mono">{String(value)}</span>;
}

function JsonNode({
  value,
  name,
  depth,
  defaultOpen,
}: {
  value: unknown;
  name?: string;
  depth: number;
  defaultOpen: boolean;
}) {
  const kind = typeOf(value);
  const isContainer = kind === "object" || kind === "array";
  const [open, setOpen] = useState(defaultOpen || depth < 1);

  const entries = useMemo(() => {
    if (kind === "array") {
      return (value as unknown[]).map((item, index) => [String(index), item] as const);
    }
    if (kind === "object") {
      return Object.entries(value as Record<string, unknown>);
    }
    return [] as ReadonlyArray<readonly [string, unknown]>;
  }, [kind, value]);

  const summary = useMemo(() => {
    if (kind === "array") {
      return entries.length === 0 ? zh.json.emptyArray : t(zh.json.itemCount, { count: entries.length });
    }
    if (kind === "object") {
      return entries.length === 0 ? zh.json.emptyObject : t(zh.json.itemCount, { count: entries.length });
    }
    return "";
  }, [kind, entries.length]);

  if (!isContainer) {
    return (
      <div className="flex items-start gap-2 py-0.5 font-mono text-[13px] leading-6">
        <span className="w-3 shrink-0" />
        {name !== undefined && (
          <span className="shrink-0 text-[var(--color-text-secondary)]">
            {name}:
          </span>
        )}
        <PrimitiveValue value={value} />
      </div>
    );
  }

  return (
    <div className="font-mono text-[13px] leading-6">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 rounded px-0.5 text-left hover:bg-[var(--color-surface)]"
        aria-label={open ? zh.json.collapse : zh.json.expand}
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--color-text-tertiary)]" />
        )}
        {name !== undefined && (
          <span className="text-[var(--color-text-secondary)]">{name}:</span>
        )}
        <span className="text-[var(--color-text-tertiary)]">
          {kind === "array" ? "[ " : "{ "}
          {!open && summary}
          {!open && (kind === "array" ? " ]" : " }")}
        </span>
      </button>
      {open && (
        <div className="ml-4 border-l border-border pl-3">
          {entries.length === 0 ? (
            <div className="py-0.5 text-[var(--color-text-tertiary)]">{summary}</div>
          ) : (
            entries.map(([key, item]) => (
              <JsonNode
                key={key}
                name={kind === "array" ? `[${key}]` : key}
                value={item}
                depth={depth + 1}
                defaultOpen={depth < 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function JsonView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(content) as unknown };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, [content]);

  if (!parsed.ok) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-error)]">
          {zh.files.jsonInvalid}
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface)] p-3 font-mono text-xs">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <JsonNode value={parsed.value} depth={0} defaultOpen />
    </div>
  );
}

export default JsonView;