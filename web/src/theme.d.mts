export type TaskboardTheme = "light" | "dark";
export function isTaskboardTheme(value: unknown): value is TaskboardTheme;
export function themeFromHostMessage(message: unknown): TaskboardTheme | null;
export function resolveTaskboardTheme(input: {
  embedded: boolean;
  hostTheme: unknown;
  queryTheme: unknown;
  systemDark: boolean;
}): TaskboardTheme;
