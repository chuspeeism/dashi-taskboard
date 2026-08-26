import { createRoot } from "react-dom/client";

import { TaskEditor, type NewTaskEditorDraft } from "../../web/src/components/TaskEditor";
import type { ActorIdentity, TaskDraft } from "../../web/src/types";

const currentUser: ActorIdentity = {
  type: "user",
  id: "reviewer",
  name: "Reviewer",
  avatarUrl: null,
};

const oldTodoDraft: NewTaskEditorDraft = {
  title: "保留的草稿標題",
  descriptionSegments: [{ id: "draft-description", type: "text", text: "保留的草稿描述" }],
  status: "todo",
  priority: "high",
  assignee: currentUser,
  selectedLabels: ["迴歸證據"],
  developmentContext: null,
  startDate: "",
  dueDate: "",
  recurrence: null,
  attachments: [],
  relations: {
    parentId: null,
    relatedIds: [],
    subIssueIds: [],
  },
};

function publishResult(draft: TaskDraft) {
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify(draft));
}

createRoot(document.getElementById("root")!).render(
  <TaskEditor
    task={null}
    tasks={[]}
    initialStatus="in_progress"
    initialDraft={oldTodoDraft}
    labels={["迴歸證據"]}
    currentUser={currentUser}
    developmentScan={{ workspacePath: null, contexts: [] }}
    developmentScanLoading={false}
    onCreateLabel={async () => {}}
    onCancel={() => {}}
    onSave={async (draft) => publishResult(draft)}
  />,
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const createButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Create issue");
    if (!(createButton instanceof HTMLButtonElement)) {
      document.documentElement.dataset.error = "create button not found";
      return;
    }
    createButton.click();
  });
});
