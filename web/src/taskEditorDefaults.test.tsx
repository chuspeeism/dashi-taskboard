import { describe, expect, it } from "vitest";
import type { DevelopmentScan } from "./types";
import { taskboardStorage } from "./storage";
import {
  currentDevelopmentContext,
  readTaskEditorDefaults,
  saveTaskEditorDefaults,
} from "./taskEditorDefaults";

describe("task editor defaults", () => {
  it("scopes saved priority and labels by project and user", () => {
    saveTaskEditorDefaults("project-a", "user:one", "high", ["bug", "frontend"]);

    expect(readTaskEditorDefaults("project-a", "user:one", ["bug", "frontend", "docs"])).toEqual({
      priority: "high",
      labels: ["bug", "frontend"],
    });
    expect(readTaskEditorDefaults("project-b", "user:one", ["bug", "frontend"])).toEqual({
      priority: "none",
      labels: [],
    });
  });

  it("drops labels that are no longer available and ignores corrupt data", () => {
    saveTaskEditorDefaults("project-a", "user:two", "urgent", ["stale"]);
    expect(readTaskEditorDefaults("project-a", "user:two", ["current"])).toEqual({
      priority: "urgent",
      labels: [],
    });

    taskboardStorage.setItem(
      `taskboard.new-task-defaults.v1.${JSON.stringify(["project-corrupt", "user:two"])}`,
      "{",
    );
    expect(readTaskEditorDefaults("project-corrupt", "user:two", ["current"])).toEqual({
      priority: "none",
      labels: [],
    });
  });

  it("uses the branch from the unique worktree matching the workspace", () => {
    const scan: DevelopmentScan = {
      workspacePath: "C:/repo",
      contexts: [
        { type: "worktree", path: "C:/repo", branch: "fix/task-editor-defaults" },
        { type: "worktree", path: "C:/other", branch: "main" },
      ],
    };

    expect(currentDevelopmentContext(scan)).toEqual({
      type: "branch",
      branch: "fix/task-editor-defaults",
    });
  });

  it("does not guess when the scan is ambiguous or detached", () => {
    expect(currentDevelopmentContext({
      workspacePath: "C:/repo",
      contexts: [
        { type: "worktree", path: "C:/repo", branch: "feature-a" },
        { type: "worktree", path: "C:/repo", branch: "feature-b" },
      ],
    })).toBeNull();
    expect(currentDevelopmentContext({
      workspacePath: "C:/repo",
      contexts: [{ type: "worktree", path: "C:/repo", branch: null }],
    })).toBeNull();
  });
});
