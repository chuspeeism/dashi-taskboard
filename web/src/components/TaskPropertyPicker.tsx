import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";

export interface TaskPropertyOption<Value extends string> {
  value: Value;
  label: string;
  icon: ReactNode;
  className?: string;
}

interface TaskPropertyPickerProps<Value extends string> {
  value: Value;
  options: readonly TaskPropertyOption<Value>[];
  open: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName: string;
  ariaLabel: string;
  title?: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: Value) => void;
}

export function TaskPropertyPicker<Value extends string>({
  value,
  options,
  open,
  disabled = false,
  className = "",
  triggerClassName,
  ariaLabel,
  title,
  onOpenChange,
  onChange,
}: TaskPropertyPickerProps<Value>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const selected = options.find((option) => option.value === value) ?? options[0];
  const portalTarget = triggerRef.current?.closest("dialog") ?? document.body;

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const openAbove = triggerRect.bottom + gap + menuRect.height > window.innerHeight - edge
      && triggerRect.top - gap - menuRect.height >= edge;
    const left = Math.max(edge, Math.min(triggerRect.left, window.innerWidth - menuRect.width - edge));
    const top = openAbove ? triggerRect.top - menuRect.height - gap : triggerRect.bottom + gap;
    setPosition({ left, top: Math.max(edge, top) });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("[aria-selected='true']")
        ?.focus({ preventScroll: true });
    });

    function closeFromOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onOpenChange(false);
      }
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      triggerRef.current?.focus();
    }

    function closeFromViewportChange() {
      onOpenChange(false);
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [onOpenChange, open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="composer-popover task-property-popover"
      role="listbox"
      aria-label={ariaLabel}
      style={{ position: "fixed", left: position.left, top: position.top }}
    >
      <div className="task-property-options">
        {options.map((option) => (
          <button
            type="button"
            role="option"
            aria-selected={option.value === value}
            className={`task-property-option${option.className ? ` ${option.className}` : ""}`}
            key={option.value}
            onClick={() => {
              onOpenChange(false);
              if (option.value !== value) onChange(option.value);
            }}
          >
            <span className="task-property-option-icon">{option.icon}</span>
            <span className="task-property-option-label">{option.label}</span>
            {option.value === value && (
              <span className="task-property-option-check"><LinearIcon name="check" /></span>
            )}
          </button>
        ))}
      </div>
    </div>,
    portalTarget,
  ) : null;

  return (
    <div ref={rootRef} className={`task-property-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => onOpenChange(!open)}
      >
        <span className="task-property-trigger-icon">{selected.icon}</span>
        <span className="task-property-trigger-label">{selected.label}</span>
      </button>
      {menu}
    </div>
  );
}
