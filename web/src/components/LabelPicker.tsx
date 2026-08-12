import { useEffect, useRef, useState, type ReactNode } from "react";
import { labelDisplayName, labelPresentation } from "../labels";
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";

interface LabelPickerProps {
  availableLabels: string[];
  selectedLabels: string[];
  open: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName: string;
  showIcon?: boolean;
  showSelectedAsChips?: boolean;
  placeholder?: string;
  triggerContent?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onChange: (labels: string[]) => void;
  onCreateLabel: (label: string) => Promise<void>;
  onDeleteLabel?: (label: string) => Promise<void>;
}

export function LabelPicker({
  availableLabels,
  selectedLabels,
  open,
  disabled = false,
  className = "",
  triggerClassName,
  showIcon = false,
  showSelectedAsChips = false,
  placeholder,
  triggerContent,
  onOpenChange,
  onChange,
  onCreateLabel,
  onDeleteLabel,
}: LabelPickerProps) {
  const { language, text } = useTaskboardI18n();
  const resolvedPlaceholder = placeholder ?? text("标签", "Labels");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const normalizedSearch = search.trim();
  const filteredLabels = availableLabels.filter((label) => (
    !normalizedSearch
    || label.toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase())
    || labelDisplayName(label, language).toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase())
  ));
  const canCreateLabel = Boolean(normalizedSearch) && !availableLabels.some((label) => (
    label === normalizedSearch
    || labelDisplayName(label, language).toLocaleLowerCase() === normalizedSearch.toLocaleLowerCase()
  ));

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [onOpenChange, open]);

  function toggleLabel(label: string) {
    if (disabled || pendingLabel) return;
    onChange(selectedLabels.includes(label)
      ? selectedLabels.filter((item) => item !== label)
      : [...selectedLabels, label]);
  }

  async function createLabel() {
    const label = normalizedSearch;
    setPendingLabel(label);
    try {
      await onCreateLabel(label);
      onChange(selectedLabels.includes(label) ? selectedLabels : [...selectedLabels, label]);
      setSearch("");
    } catch {
      // The caller reports API errors in the shared action banner.
    } finally {
      setPendingLabel(null);
    }
  }

  async function deleteLabel(label: string) {
    if (!onDeleteLabel) return;
    setPendingLabel(label);
    try {
      await onDeleteLabel(label);
    } catch {
      // The caller reports API errors in the shared action banner.
    } finally {
      setPendingLabel(null);
    }
  }

  return (
    <div ref={rootRef} className={`composer-menu-anchor label-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-label={text("选择或创建标签", "Select or create labels")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {triggerContent ?? <>
          {showIcon && <LinearIcon name="label" />}
          {selectedLabels.length > 0 && showSelectedAsChips ? (
            <span className="label-trigger-chips">
              {selectedLabels.map((label) => {
                const presentation = labelPresentation(label, language);
                return (
                  <span className="label-trigger-chip" key={label}>
                    {presentation.tone && <i style={{ background: presentation.color }} />}
                    {presentation.name}
                  </span>
                );
              })}
            </span>
          ) : (
            <span>{selectedLabels.length > 0
              ? selectedLabels.map((label) => labelDisplayName(label, language)).join(", ")
              : resolvedPlaceholder}</span>
          )}
        </>}
      </button>
      {open && (
        <div className="composer-popover label-popover" role="dialog" aria-label={text("选择或创建标签", "Select or create labels")}>
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={text("添加标签…", "Add labels…")}
            aria-label={text("搜索标签", "Search labels")}
          />
          <div className="label-options" role="listbox" aria-label={text("可用标签", "Available labels")} aria-multiselectable="true">
            {filteredLabels.map((label) => {
              const presentation = labelPresentation(label, language);
              return (
                <div className="label-option-row" role="presentation" key={label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedLabels.includes(label)}
                    disabled={disabled || pendingLabel !== null}
                    onClick={() => toggleLabel(label)}
                  >
                    <i style={{ background: presentation.tone ? presentation.color : "transparent" }} />
                    <span>{presentation.name}</span>
                    {selectedLabels.includes(label) && <b><LinearIcon name="check" /></b>}
                  </button>
                  {onDeleteLabel && (
                    <button
                      type="button"
                      className="label-delete-button"
                      disabled={disabled || pendingLabel !== null}
                      aria-label={text(`删除标签 ${presentation.name}`, `Delete label ${presentation.name}`)}
                      title={text("删除标签", "Delete label")}
                      onClick={() => void deleteLabel(label)}
                    >
                      <LinearIcon name="trash" />
                    </button>
                  )}
                </div>
              );
            })}
            {canCreateLabel && (
              <button
                type="button"
                disabled={disabled || pendingLabel !== null}
                onClick={() => void createLabel()}
              >
                <i style={{
                  background: labelPresentation(normalizedSearch, language).tone
                    ? labelPresentation(normalizedSearch, language).color
                    : "transparent",
                }} />
                <span>{text(`创建 “${normalizedSearch}”`, `Create “${normalizedSearch}”`)}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
