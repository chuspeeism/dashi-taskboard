import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../types";
import { TaskDetail } from "./TaskDetail";

const fixtures = vi.hoisted(() => {
  const taskAttachment = {
    id: "task-attachment",
    taskId: "task-id",
    commentId: null,
    kind: "attachment" as const,
    filename: "task.txt",
    contentType: "text/plain",
    size: 12,
    createdAt: "2026-09-09T00:00:00.000Z",
  };
  const commentAttachment = {
    id: "comment-attachment",
    taskId: "task-id",
    commentId: "comment-id",
    kind: "attachment" as const,
    filename: "comment.txt",
    contentType: "text/plain",
    size: 18,
    createdAt: "2026-09-09T00:00:00.000Z",
  };
  return {
    taskAttachment,
    commentAttachment,
    listAttachments: vi.fn(async () => [taskAttachment]),
    listComments: vi.fn(async () => [{
      id: "comment-id",
      taskId: "task-id",
      body: "",
      authorType: "user" as const,
      authorId: "user-id",
      authorName: "User",
      authorAvatarUrl: null,
      threadId: null,
      threadBinding: null,
      legacyLocalThreadId: null,
      attachments: [commentAttachment],
      version: 1,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    }]),
    listTaskActivities: vi.fn(async () => []),
    deleteAttachment: vi.fn(async () => undefined),
  };
});

vi.mock("../api", () => ({
  ApiError: class ApiError extends Error {},
  attachmentDownloadUrl: ({ id }: { id: string }) => `api/attachments/${id}/download`,
  createComment: vi.fn(),
  deleteAttachment: fixtures.deleteAttachment,
  deleteComment: vi.fn(),
  getTask: vi.fn(),
  listAttachments: fixtures.listAttachments,
  listComments: fixtures.listComments,
  listTaskActivities: fixtures.listTaskActivities,
  resolveTaskboardUrl: (value: string) => value,
  uploadAttachment: vi.fn(),
  uploadCommentAttachment: vi.fn(),
  updateComment: vi.fn(),
}));

vi.mock("./ActorAvatar", () => ({ ActorAvatar: () => <span /> }));
vi.mock("./DescriptionDocument", () => ({
  DescriptionDocument: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock("./InlineMediaComposer", () => ({
  InlineMediaComposer: forwardRef((_props: unknown, ref) => {
    useImperativeHandle(ref, () => ({
      addFiles: vi.fn(),
      focus: vi.fn(),
      focusAtText: vi.fn(),
    }));
    return <div />;
  }),
}));
vi.mock("./IssueRelations", () => ({
  IssueParentLink: () => null,
  IssueRelationSidebar: () => null,
  IssueSubIssues: () => null,
}));
vi.mock("./LabelPicker", () => ({ LabelPicker: () => null }));
vi.mock("./TaskPropertyPicker", () => ({ TaskPropertyPicker: () => null }));

const task: Task = {
  id: "task-id",
  identifier: "TASK-1",
  projectId: "project-id",
  title: "Attachment list regression",
  description: "",
  status: "todo",
  priority: "none",
  labels: [],
  sortOrder: 0,
  threadId: null,
  threadBinding: null,
  legacyLocalThreadId: null,
  conversationRefs: [],
  participants: [],
  previewImage: null,
  activityKey: "activity-key",
  activityUpdatedAt: "2026-09-09T00:00:00.000Z",
  creatorType: "user",
  creatorId: "user-id",
  creatorName: "User",
  creatorAvatarUrl: null,
  assignee: { type: "user", id: "user-id", name: "User", avatarUrl: null },
  developmentContext: null,
  startDate: null,
  dueDate: null,
  recurrence: null,
  source: "local",
  externalOrigin: null,
  externalKey: null,
  externalUrl: null,
  archivedAt: null,
  relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

function renderTaskDetail() {
  return render(
    <TaskDetail
      task={task}
      tasks={[task]}
      referenceTasks={[]}
      currentUser={{ type: "user", id: "user-id", name: "User", avatarUrl: null }}
      availableLabels={[]}
      developmentScan={{ workspacePath: null, contexts: [] }}
      developmentScanLoading={false}
      commentsRevision={0}
      attachmentsRevision={0}
      onCreateLabel={vi.fn(async () => undefined)}
      onDeleteLabel={vi.fn(async () => undefined)}
      onUpdate={vi.fn(async (value) => value)}
      onOpenTask={vi.fn()}
      onAddRelation={vi.fn(async () => ({ task, relatedTask: task }))}
      onRemoveRelation={vi.fn(async () => ({ task, relatedTask: task }))}
      onOpenThread={vi.fn()}
      onOpenLegacyLocalThread={vi.fn()}
      onOpenInThread={vi.fn()}
      onCopy={vi.fn()}
      openingThread={false}
      onError={vi.fn()}
    />,
  );
}

describe("TaskDetail attachment lists", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders task and comment attachments that are not referenced in text", async () => {
    renderTaskDetail();

    await waitFor(() => expect(screen.getByText("task.txt")).not.toBeNull());

    const taskList = document.querySelector<HTMLElement>(".attachment-list");
    expect(taskList).not.toBeNull();
    if (!taskList) return;
    expect(screen.getByRole("heading", { name: "Attachments" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add attachment" })).not.toBeNull();
    expect(within(taskList).getByText("task.txt")).not.toBeNull();
    expect(within(screen.getByRole("list", { name: "Comment attachments" })).getByText("comment.txt"))
      .not.toBeNull();
  });

  it("deletes an attachment through the existing delete API and removes it from the list", async () => {
    renderTaskDetail();

    const deleteButton = await screen.findByRole("button", { name: "Delete task.txt" });
    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));

    await waitFor(() => expect(fixtures.deleteAttachment).toHaveBeenCalledWith(fixtures.taskAttachment));
    await waitFor(() => expect(screen.queryByText("task.txt")).toBeNull());
  });
});
