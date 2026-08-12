import { useEffect, useMemo, useRef, useState } from "react";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";
import { WORKFLOW_GROUPS, type PaletteItem } from "./workflowCatalog";
import { workflowText } from "./workflowI18n";
import { WorkflowMark } from "./WorkflowMark";

interface WorkflowStepPickerProps {
  items: PaletteItem[];
  onSelect: (item: PaletteItem) => void;
  onClose: () => void;
}

export function WorkflowStepPicker({ items, onSelect, onClose }: WorkflowStepPickerProps) {
  const { text } = useTaskboardI18n();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;

    return items.filter((item) => (
      `${item.group} ${item.title} ${item.description} ${item.data.title} ${item.data.description} ${item.data.meta} ${workflowText(text, item.group)} ${workflowText(text, item.title)} ${workflowText(text, item.description)} ${workflowText(text, item.data.title)} ${workflowText(text, item.data.description)} ${workflowText(text, item.data.meta)}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ));
  }, [items, query, text]);

  const groups = useMemo(() => {
    const availableGroups = new Set(filteredItems.map((item) => item.group));
    return [
      ...WORKFLOW_GROUPS.filter((group) => availableGroups.has(group)),
      ...[...availableGroups].filter((group) => !WORKFLOW_GROUPS.includes(group as typeof WORKFLOW_GROUPS[number])),
    ];
  }, [filteredItems]);

  return (
    <div className="workflow-step-picker-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="workflow-step-picker"
        role="dialog"
        aria-label={text("添加流程步骤", "Add workflow step")}
        aria-modal="true"
      >
        <header className="workflow-step-picker-header">
          <strong>{text("添加流程步骤", "Add workflow step")}</strong>
          <button type="button" aria-label={text("关闭", "Close")} onClick={onClose}>
            <LinearIcon name="close" />
          </button>
        </header>

        <label className="workflow-step-picker-search">
          <LinearIcon name="search" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={text("搜索应用或动作…", "Search apps or actions…")}
            aria-label={text("搜索应用或动作", "Search apps or actions")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="workflow-step-picker-groups">
          {groups.map((group) => (
            <section className="workflow-step-picker-group" key={group}>
              <h3>{workflowText(text, group)}</h3>
              <div className="workflow-step-picker-items">
                {filteredItems.filter((item) => item.group === group).map((item) => (
                  <button
                    className="workflow-step-picker-item"
                    type="button"
                    key={`${item.group}-${item.data.kind}`}
                    onClick={() => onSelect(item)}
                  >
                    <span className={`workflow-step-picker-mark tone-${item.data.tone}`}>
                      <WorkflowMark
                        icon={item.data.icon}
                        logo={item.data.logo}
                        logoMonochrome={item.data.logoMonochrome}
                      />
                    </span>
                    <span className="workflow-step-picker-copy">
                      <strong>{workflowText(text, item.title)}</strong>
                      <span>{workflowText(text, item.description)}</span>
                    </span>
                    <LinearIcon className="workflow-step-picker-chevron" name="chevronRight" />
                  </button>
                ))}
              </div>
            </section>
          ))}
          {filteredItems.length === 0 && (
            <p className="workflow-step-picker-empty">
              {text("没有匹配的应用或动作", "No matching apps or actions")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
