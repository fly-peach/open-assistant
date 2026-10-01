"use client";

/**
 * 子 agent 的工具白名单控件（受控，无内部状态）。
 *
 * 两种模式二选一，因为「未声明」与「声明为空数组」是两件完全不同的事：
 * - 继承：`tools: null` —— 用主 agent 已开启的工具组（后端会删掉这个键）；
 * - 自定义：写死一份工具名清单（可以一个都不勾 = 什么工具都不给）。
 *
 * 工具清单**从后端来**（`GET /agents/{id}/team` 的 `toolCatalog`），前端不硬编码工具名：
 * 工具名与「某个组是否被主 agent 关掉」都只有后端知道，硬编码会漂移。
 * 被关掉的组要显式标注 —— 否则用户勾了没反应，只会以为是坏了
 * （specs/subagent-team「工具组开关对子 agent 生效」）。
 */
import zh, { t } from "@/i18n/zh";
import type { ToolCatalogGroup } from "@/lib/teamApi";
import {
  buildToolRows,
  toolGroupLabel,
  type ToolsMode,
} from "@/app/utils/teamConfig";

export interface ToolWhitelistPickerProps {
  /** 所属成员（用于 radio 分组名，避免多张卡片互相抢选中态）。 */
  scope: string;
  catalog: ToolCatalogGroup[];
  mode: ToolsMode;
  selected: string[];
  disabled?: boolean;
  onModeChange: (mode: ToolsMode) => void;
  onToggle: (name: string) => void;
}

export function ToolWhitelistPicker({
  scope,
  catalog,
  mode,
  selected,
  disabled = false,
  onModeChange,
  onToggle,
}: ToolWhitelistPickerProps) {
  const { groups, unknown } = buildToolRows(catalog, selected);
  const radioName = `team-tools-mode-${scope}`;

  return (
    <div data-team-tools={scope}>
      <p className="text-sm font-medium">{zh.team.toolsLabel}</p>
      <p className="text-xs text-muted-foreground">{zh.team.toolsHint}</p>

      <div className="mt-2 grid gap-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="radio"
            name={radioName}
            checked={mode === "inherit"}
            disabled={disabled}
            onChange={() => onModeChange("inherit")}
            data-team-tools-mode="inherit"
          />
          {zh.team.toolsInherit}
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="radio"
            name={radioName}
            checked={mode === "custom"}
            disabled={disabled}
            onChange={() => onModeChange("custom")}
            data-team-tools-mode="custom"
          />
          {zh.team.toolsCustom}
        </label>
      </div>

      {mode === "custom" && (
        <div
          className="mt-2 grid gap-2 rounded border border-border p-2"
          data-team-tools-grid={scope}
        >
          {groups.map((group) => (
            <div
              key={group.group}
              data-team-tools-group={group.group}
              data-team-tools-group-enabled={group.enabled ? "true" : "false"}
            >
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">{toolGroupLabel(group.group)}</span>
                {!group.enabled && (
                  <span
                    className="text-[var(--color-warning)]"
                    data-team-tools-group-disabled={group.group}
                  >
                    {zh.team.toolsGroupDisabled}
                  </span>
                )}
              </p>
              {group.tools.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{zh.team.toolsGroupEmpty}</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-2">
                  {group.tools.map((tool) => (
                    <label
                      key={tool.name}
                      data-team-tool={tool.name}
                      data-team-tool-enabled={tool.checked ? "true" : "false"}
                      className={
                        group.enabled
                          ? "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
                          : "inline-flex items-center gap-1.5 rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={tool.checked}
                        disabled={disabled}
                        onChange={() => onToggle(tool.name)}
                        data-team-tool-checkbox={tool.name}
                      />
                      {tool.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}

          {unknown.length > 0 && (
            <p
              className="text-[11px] text-[var(--color-warning)]"
              data-team-tools-unknown
            >
              {t(zh.team.toolsUnknown, { tools: unknown.join(", ") })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
