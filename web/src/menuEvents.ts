import type { RefObject } from "react";

export function listenForOutsidePointerDown(
  boundaries: readonly RefObject<HTMLElement | null>[],
  onOutside: () => void,
) {
  function handlePointerDown(event: PointerEvent) {
    if (!boundaries.some((ref) => ref.current?.contains(event.target as Node))) onOutside();
  }
  document.addEventListener("pointerdown", handlePointerDown);
  return () => document.removeEventListener("pointerdown", handlePointerDown);
}

export function listenForMenuViewportChange(
  menuRef: RefObject<HTMLElement | null>,
  onChange: () => void,
) {
  function handleChange(event: Event) {
    if (event.type === "scroll" && menuRef.current?.contains(event.target as Node)) return;
    onChange();
  }
  window.addEventListener("blur", handleChange);
  window.addEventListener("resize", handleChange);
  window.addEventListener("scroll", handleChange, true);
  return () => {
    window.removeEventListener("blur", handleChange);
    window.removeEventListener("resize", handleChange);
    window.removeEventListener("scroll", handleChange, true);
  };
}
