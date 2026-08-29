import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildPersistedTaskComposerDocument } from "../web/src/taskConversations.ts";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);
const editorSource = await readFile(
  new URL("../web/src/components/TaskEditor.tsx", import.meta.url),
  "utf8",
);

test("all four issue composers request candidates with the owning project and surface", () => {
  assert.match(
    editorSource,
    /completionContext=\{projectId \? \{ projectId, surface: "issue-description" \} : undefined\}/,
  );
  assert.equal(
    detailSource.match(/surface: "issue-description"/g)?.length,
    1,
  );
  assert.equal(detailSource.match(/surface: "comment"/g)?.length, 2);
  assert.match(appSource, /projectId=\{editorProjectId\}/);
});

test("task composer document converts only durable references and keeps slash and legacy syntax as text", () => {
  const document = buildPersistedTaskComposerDocument("before\n", [
    { id: "a", type: "text", text: "/model [legacy](subagent://master) $old " },
    {
      id: "b",
      type: "skill-reference",
      markdown: "[review](taskboard://composer-reference/v1/skill/cmV2aWV3)",
      referenceKey: "cmV2aWV3",
      label: "review",
    },
    { id: "c", type: "text", text: " and " },
    {
      id: "d",
      type: "agent-reference",
      markdown: "[master](taskboard://composer-reference/v1/agent/bWFzdGVy)",
      referenceKey: "bWFzdGVy",
      label: "master",
    },
    {
      id: "e",
      type: "unsupported-reference",
      markdown: "[future](taskboard://composer-reference/v2/plugin/cGx1Z2lu)",
      referenceUri: "taskboard://composer-reference/v2/plugin/cGx1Z2lu",
      label: "future",
    },
  ], "\nafter");

  assert.deepEqual(document, {
    version: 1,
    nodes: [
      { type: "text", text: "before\n/model [legacy](subagent://master) $old " },
      {
        type: "persistedReference",
        referenceKind: "skill",
        referenceKey: "cmV2aWV3",
        label: "review",
      },
      { type: "text", text: " and " },
      {
        type: "persistedReference",
        referenceKind: "agent",
        referenceKey: "bWFzdGVy",
        label: "master",
      },
      {
        type: "unsupportedReference",
        referenceUri: "taskboard://composer-reference/v2/plugin/cGx1Z2lu",
        label: "future",
      },
      { type: "text", text: "\nafter" },
    ],
  });
});

test("open in new conversation bypasses AI chat while its durable reference rebind stays internal", () => {
  assert.match(apiSource, /"\/api\/local\/ai\/composer\/rebind"/);
  assert.doesNotMatch(appSource, /rebindAiChatComposerReferences/);
  assert.match(appSource, /type: "taskboard:create-thread"/);
  assert.match(chatSource, /await rebindAiChatComposerReferences\(\{/);
  assert.match(chatSource, /if \(!unavailable\) tokenElement\.dataset\.composerCandidateRef = node\.candidateRef/);
  assert.match(chatSource, /setComposerRevision\(composerDraft\.revision\)/);
  assert.match(chatSource, /\|\| composerRebindBlocked/);
  assert.match(chatSource, /node\.type === "skill" \|\| node\.type === "agent"/);
});
