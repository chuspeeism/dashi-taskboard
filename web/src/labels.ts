import type { TaskboardLanguage } from "./i18n";

export const DEFAULT_LABELS = [
  { name: "缺陷", color: "#eb5757" },
  { name: "特性", color: "#bb87fc" },
  { name: "for-claude", color: "#5b8cff" },
  { name: "hold", color: "#d99b25" },
  { name: "改进", color: "#4ea7fc" },
  { name: "phase-1", color: "#1d4ed8" },
  { name: "phase-2", color: "#0f766e" },
  { name: "phase-3", color: "#7c3aed" },
  { name: "phase-4", color: "#b45309" },
  { name: "phase-5", color: "#be123c" },
  { name: "phase-6", color: "#475569" },
] as const;

export function labelColor(name: string): string {
  return DEFAULT_LABELS.find((label) => label.name === name)?.color ?? "#8b8d92";
}

export type LabelTone = "bug" | "feature" | null;

export function labelDisplayName(name: string, language: TaskboardLanguage = "zh"): string {
  if (name === "缺陷" || name.toLocaleUpperCase() === "BUG") return "BUG";
  if (name === "特性" || name === "新功能") return language === "zh" ? "新功能" : "Feature";
  if (name === "改进") return language === "zh" ? "改进" : "Improvement";
  return name;
}

export function labelTone(name: string): LabelTone {
  if (name === "缺陷" || name.toLocaleUpperCase() === "BUG") return "bug";
  if (name === "特性" || name === "新功能") return "feature";
  return null;
}

export function labelPresentation(name: string, language: TaskboardLanguage = "zh") {
  const tone = labelTone(name);
  return {
    name: labelDisplayName(name, language),
    tone,
    color: tone === "bug" ? "#eb5757" : tone === "feature" ? "#bb87fc" : labelColor(name),
  };
}
