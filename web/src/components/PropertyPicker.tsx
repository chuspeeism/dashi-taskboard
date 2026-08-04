import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LinearIcon } from "./LinearIcon";

export interface PropertyPickerOption {
  value: string;
  label: string;
  group?: string;
  icon?: ReactNode;
}

interface PropertyPickerProps {
  value: string;
  options: PropertyPickerOption[];
  icon?: ReactNode;
  open: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName: string;
  placeholder: string;
  ariaLabel: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  hideSelectedOption?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}

export function PropertyPicker({
  value,
  options,
  icon,
  open,
  disabled = false,
  className = "",
  triggerClassName,
  placeholder,
  ariaLabel,
  searchable = false,
  searchPlaceholder = "搜索…",
  hideSelectedOption = false,
  onOpenChange,
  onChange,
}: PropertyPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const selectedOption = options.find((option) => option.value === value);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredOptions = searchable
    ? options.filter((option) => (
      !normalizedSearch || option.label.toLocaleLowerCase().includes(normalizedSearch)
    ))
    : options;
  const visibleOptions = hideSelectedOption
    ? filteredOptions.filter((option) => option.value !== value)
    : filteredOptions;

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

  function selectOption(optionValue: string) {
    if (disabled) return;
    onChange(optionValue);
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  let previousGroup: string | undefined;

  return (
    <div ref={rootRef} className={`composer-menu-anchor property-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`property-picker-trigger ${triggerClassName}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {icon && <span className="property-picker-trigger-icon">{icon}</span>}
        <span className="property-picker-trigger-value">{selectedOption?.label ?? placeholder}</span>
        <LinearIcon name="chevronDown" className="property-picker-chevron" />
      </button>
      {open && (
    <div
      className={`composer-popover label-popover property-picker-popover${searchable ? " is-searchable" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
    >
          {searchable && (
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={`搜索${ariaLabel}`}
            />
          )}
          <div className="label-options property-picker-options" role="listbox" aria-label={ariaLabel}>
            {visibleOptions.length > 0 ? visibleOptions.map((option) => {
              const showGroup = Boolean(option.group && option.group !== previousGroup);
              previousGroup = option.group;
              return (
                <Fragment key={option.value}>
                  {showGroup && <div className="property-picker-group" role="presentation">{option.group}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={disabled}
                    onClick={() => selectOption(option.value)}
                  >
                    <span className="property-picker-option-icon">{option.icon}</span>
                    <span className="property-picker-option-label">{option.label}</span>
                    {option.value === value && <b className="property-picker-option-check"><LinearIcon name="check" /></b>}
                  </button>
                </Fragment>
              );
            }) : (
              <div className="property-picker-empty">没有匹配的选项</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
