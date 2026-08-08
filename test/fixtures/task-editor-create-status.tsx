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
  title: "保留的草稿标题",
  descriptionSegments: [{ id: "draft-description", type: "text", text: "保留的草稿描述" }],
  status: "todo",
  priority: "high",
  assignee: currentUser,
  selectedLabels: ["回归证据"],
  developmentContext: null,
  startDate: "",
  dueDate: "",
  recurrence: null,
  attachments: [],
};

function publishResult(draft: TaskDraft) {
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify(draft));
}

createRoot(document.getElementById("root")!).render(
  <TaskEditor
    task={null}
    initialStatus="in_progress"
    initialDraft={oldTodoDraft}
    labels={["回归证据"]}
    currentUser={currentUser}
    developmentScan={{ workspacePath: null, contexts: [] }}
    developmentScanLoading={false}
    onCancel={() => {}}
    onSave={async (draft) => publishResult(draft)}
  />,
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const createButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "创建议题");
    if (!(createButton instanceof HTMLButtonElement)) {
      document.documentElement.dataset.error = "create button not found";
      return;
    }
    createButton.click();
  });
});
