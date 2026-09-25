import { describe, expect, it } from "vitest";
import type { TaskCardPresentation } from "../taskConversations";
import type { Task } from "../types";
import { selectAttentionItems } from "./DashboardView";

function task(id: string, status: Task["status"], activityUpdatedAt: string) {
  return { id, status, activityUpdatedAt } as Task;
}

function presentation(unread: boolean) {
  return { unread } as TaskCardPresentation;
}

describe("Dashboard review visibility", () => {
  it("keeps every In Review task visible even when it is read and older than five other items", () => {
    const reviewTasks = Array.from({ length: 7 }, (_, index) => (
      task(`review-${index}`, "in_review", `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)
    ));
    const unread = task("unread", "todo", "2026-09-30T00:00:00.000Z");
    const presentations = Object.fromEntries([
      ...reviewTasks.map((item) => [item.id, presentation(false)]),
      [unread.id, presentation(true)],
    ]);

    const selected = selectAttentionItems([...reviewTasks, unread], presentations);

    expect(selected.filter((item) => item.status === "in_review")).toHaveLength(7);
    expect(selected.slice(0, 7).every((item) => item.status === "in_review")).toBe(true);
    expect(selected.at(-1)?.id).toBe("unread");
  });
});
