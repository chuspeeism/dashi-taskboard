import { listenForOutsidePointerDown } from "../menuEvents";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
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
  popoverClassName?: string;
  triggerClassName: string;
  triggerContent?: ReactNode;
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
  popoverClassName = "",
  triggerClassName,
  triggerContent,
  ariaLabel,
  title,
  onOpenChange,
  onChange,
}: TaskPropertyPickerProps<Value>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [focusedIndex, setFocusedIndex] = useState(0);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const portalTarget = triggerRef.current?.closest("dialog, [role='dialog']") ?? document.body;

  function optionElements(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
  }

  function selectOption(option: TaskPropertyOption<Value>) {
    onOpenChange(false);
    if (option.value !== value) onChange(option.value);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const elements = optionElements();
    const currentIndex = elements.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Tab") {
      requestAnimationFrame(() => onOpenChange(false));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (currentIndex < 0) return;
      event.preventDefault();
      selectOption(options[currentIndex]);
      return;
    }
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, elements.length - 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = elements.length - 1;
    else return;
    event.preventDefault();
    setFocusedIndex(nextIndex);
    elements[nextIndex]?.focus();
  }

  function closeFromFocusLeave(event: FocusEvent<HTMLElement>) {
    if (menuRef.current?.matches(":active")) return;
    const next = event.relatedTarget as Node | null;
    if (!next || (!rootRef.current?.contains(next) && !menuRef.current?.contains(next))) {
      onOpenChange(false);
    }
  }

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
    const nextIndex = Math.max(0, options.findIndex((option) => option.value === value));
    setFocusedIndex(nextIndex);
    requestAnimationFrame(() => optionElements()[nextIndex]?.focus({ preventScroll: true }));
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const stopOutside = listenForOutsidePointerDown([rootRef, menuRef], () => onOpenChange(false));

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus();
    }

    function closeFromViewportChange(event: Event) {
      if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    }

    window.addEventListener("keydown", closeFromEscape);
    const viewportListenerFrame = requestAnimationFrame(() => {
      window.addEventListener("resize", closeFromViewportChange);
      window.addEventListener("scroll", closeFromViewportChange, true);
    });
    return () => {
      stopOutside();
      window.removeEventListener("keydown", closeFromEscape);
      cancelAnimationFrame(viewportListenerFrame);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [onOpenChange, open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className={`composer-popover task-property-popover${popoverClassName ? ` ${popoverClassName}` : ""}`}
      role="listbox"
      aria-label={ariaLabel}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onKeyDown={handleMenuKeyDown}
      onBlur={closeFromFocusLeave}
    >
      <div className="task-property-options">
        {options.map((option, index) => (
          <button
            type="button"
            role="option"
            aria-selected={option.value === value}
            tabIndex={index === focusedIndex ? 0 : -1}
            className={`task-property-option${option.className ? ` ${option.className}` : ""}`}
            key={option.value}
            onClick={() => selectOption(option)}
            onFocus={() => setFocusedIndex(index)}
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
    <div ref={rootRef} className={`task-property-picker${className ? ` ${className}` : ""}`} onBlur={closeFromFocusLeave}>
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
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onOpenChange(true);
        }}
      >
        {triggerContent ?? (
          <>
            <span className="task-property-trigger-icon">{selected.icon}</span>
            <span className="task-property-trigger-label">{selected.label}</span>
          </>
        )}
      </button>
      {menu}
    </div>
  );
}
