import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(pathname) {
  return readFile(new URL(pathname, root), "utf8");
}

test("issue model and editor preserve a concrete assignee identity", async () => {
  const [typesSource, appSource, editorSource] = await Promise.all([
    source("web/src/types.ts"),
    source("web/src/App.tsx"),
    source("web/src/components/TaskEditor.tsx"),
  ]);

  assert.match(typesSource, /export type AssigneeTarget = "current-user" \| "codex-agent"/);
  assert.match(typesSource, /assignee: ActorIdentity/);
  assert.match(typesSource, /export interface TaskDraft \{[\s\S]*?assigneeTarget\?: AssigneeTarget/);
  assert.match(appSource, /assigneeTarget/);
  assert.match(editorSource, /currentUser: ActorIdentity/);
  assert.match(editorSource, /ariaLabel=\{text\("負責人", "Assignee"\)\}/);
  assert.match(editorSource, /CODEX_AGENT_ACTOR/);
});

test("issue detail and cards expose the same assignee identity", async () => {
  const [detailSource, cardSource, avatarSource, styles] = await Promise.all([
    source("web/src/components/TaskDetail.tsx"),
    source("web/src/components/TaskCard.tsx"),
    source("web/src/components/ActorAvatar.tsx"),
    source("web/src/styles.css"),
  ]);

  assert.match(detailSource, /detail-property-label">\{text\("負責人", "Assignee"\)\}/);
  assert.match(detailSource, /saveTask\(\{ assigneeTarget \}, "assignee"\)/);
  assert.match(cardSource, /value=\{actorKey\(task\.assignee\)\}/);
  assert.match(avatarSource, /codex-agent-logo\.png/);
  assert.match(avatarSource, /actor-avatar-\$\{actor\.type\}/);
  assert.match(styles, /\.task-participant-avatar/);
});

test("issue card assignee control uses compact participant avatars", async () => {
  const [cardSource, styles] = await Promise.all([
    source("web/src/components/TaskCard.tsx"),
    source("web/src/styles.css"),
  ]);

  assert.match(
    cardSource,
    /<TaskPropertyPicker[\s\S]*?className="task-participants-control card-property-control"[\s\S]*?triggerClassName="task-assignee-trigger"[\s\S]*?triggerContent=\{<ParticipantAvatars participants=\{participants\} \/>\}[\s\S]*?ariaLabel=\{text\(`\$\{displayIdentifier\} 負責人`, `\$\{displayIdentifier\} assignee`\)\}/,
  );
  assert.match(
    styles,
    /\.task-participant-avatar\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s,
  );
  assert.match(
    styles,
    /\.task-assignee-trigger\s*\{[^}]*display:\s*inline-flex;[^}]*height:\s*20px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
});
