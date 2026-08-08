import { useEffect, useRef, useState, type ReactNode } from "react";
import { labelDisplayName, labelPresentation } from "../labels";
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
  placeholder = "标签",
  triggerContent,
  onOpenChange,
  onChange,
}: LabelPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim();
  const filteredLabels = availableLabels.filter((label) => (
    !normalizedSearch
    || label.toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase())
    || labelDisplayName(label).toLocaleLowerCase().includes(normalizedSearch.toLocaleLowerCase())
  ));
  const canCreateLabel = Boolean(normalizedSearch) && !availableLabels.some((label) => (
    label === normalizedSearch
    || labelDisplayName(label).toLocaleLowerCase() === normalizedSearch.toLocaleLowerCase()
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
    if (disabled) return;
    onChange(selectedLabels.includes(label)
      ? selectedLabels.filter((item) => item !== label)
      : [...selectedLabels, label]);
  }

  return (
    <div ref={rootRef} className={`composer-menu-anchor label-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-label="选择或创建标签"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {triggerContent ?? <>
          {showIcon && <LinearIcon name="label" />}
          {selectedLabels.length > 0 && showSelectedAsChips ? (
            <span className="label-trigger-chips">
              {selectedLabels.map((label) => {
                const presentation = labelPresentation(label);
                return (
                  <span className="label-trigger-chip" key={label}>
                    {presentation.tone && <i style={{ background: presentation.color }} />}
                    {presentation.name}
                  </span>
                );
              })}
            </span>
          ) : (
            <span>{selectedLabels.length > 0 ? selectedLabels.map(labelDisplayName).join(", ") : placeholder}</span>
          )}
        </>}
      </button>
      {open && (
        <div className="composer-popover label-popover" role="dialog" aria-label="选择或创建标签">
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Add labels…"
            aria-label="搜索标签"
          />
          <div className="label-options" role="listbox" aria-label="可用标签" aria-multiselectable="true">
            {filteredLabels.map((label) => {
              const presentation = labelPresentation(label);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedLabels.includes(label)}
                  disabled={disabled}
                  key={label}
                  onClick={() => toggleLabel(label)}
                >
                  <i style={{ background: presentation.tone ? presentation.color : "transparent" }} />
                  <span>{presentation.name}</span>
                  {selectedLabels.includes(label) && <b><LinearIcon name="check" /></b>}
                </button>
              );
            })}
            {canCreateLabel && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  toggleLabel(normalizedSearch);
                  setSearch("");
                }}
              >
                <i style={{
                  background: labelPresentation(normalizedSearch).tone
                    ? labelPresentation(normalizedSearch).color
                    : "transparent",
                }} />
                <span>创建 “{normalizedSearch}”</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
