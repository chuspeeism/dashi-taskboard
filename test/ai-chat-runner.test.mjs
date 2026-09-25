import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import {
  ComposerCatalog,
  composerCandidatesForSurface,
  loadSlashCommands,
} from "../server/ai-chat-catalog.mjs";
import {
  composerReferencePersistence,
  decodeComposerReferenceKey,
  parseComposerReferenceUri,
} from "../shared/composer-reference.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { normalizeCodexEvent } from "../server/ai-chat-process.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function createComposerCatalogFixture(issueSlashCommands) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-composer-catalog-"));
  const agentsDirectory = path.join(directory, "agents");
  await mkdir(agentsDirectory);
  await writeFile(path.join(agentsDirectory, "master.toml"), [
    'name = "任务总管"',
    'description = "协调专业 agents"',
    'developer_instructions = "按任务分工协调 agents"',
  ].join("\n"));
  let skills = [{
    skills: [{
      name: "release-skill",
      enabled: true,
      path: "/private/secret/release-skill/SKILL.md",
      description: "Release workflow",
      interface: { displayName: "Release Skill" },
    }],
  }];
  let skillsError = null;
  const subscribers = new Set();
  const appServer = {
    async listSkills() {
      if (skillsError) throw skillsError;
      return skills;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  const catalog = new ComposerCatalog({ appServer, agentsDirectory, issueSlashCommands });
  return {
    catalog,
    directory,
    setSkills(value) { skills = value; },
    setSkillsError(value) { skillsError = value; },
    async close() {
      catalog.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("versioned Slash catalog applies platform and debug filters", async () => {
  const darwin = await loadSlashCommands("darwin");
  assert.ok(darwin.length > 4);
  assert.ok(darwin.some((command) => command.id === "app"));
  assert.ok(!darwin.some((command) => command.id === "sandbox-add-read-dir"));
  assert.ok(!darwin.some((command) => command.id === "rollout"));
});

test("issue composer candidates persist canonical Agent and Skill markers without paths", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    const agentResponse = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "@",
      query: "任务",
    });
    assert.equal(agentResponse.candidates.length, 1);
    assert.equal(agentResponse.candidates[0].kind, "agent");
    assert.equal(agentResponse.candidates[0].label, "任务总管");
    assert.equal(agentResponse.candidates[0].persistence.kind, "agent");
    assert.equal(
      decodeComposerReferenceKey(agentResponse.candidates[0].persistence.referenceKey),
      "任务总管",
    );

    const skillResponse = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "@",
      query: "release",
    });
    const serialized = JSON.stringify(skillResponse);
    assert.equal(skillResponse.candidates.length, 1);
    assert.equal(skillResponse.candidates[0].persistence.format, "taskboard.composer-reference.v1");
    assert.equal(
      parseComposerReferenceUri(
        skillResponse.candidates[0].persistence.markdown.match(/\(([^)]+)\)$/)[1],
      ).stableId,
      "release-skill",
    );
    assert.equal(serialized.includes("/private/secret"), false);
    assert.equal(serialized.includes("candidateRef"), true);

    const issueSlash = composerCandidatesForSurface(
      await fixture.catalog.candidates({ workspacePath: "/workspace", trigger: "/", query: "new" }),
      "issue-description",
    );
    assert.deepEqual(issueSlash.candidates[0].selection, { type: "insertText", text: "/new" });
    assert.equal("dispatch" in issueSlash.candidates[0], false);
    const aiChatSlash = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "/",
      query: "new",
    });
    assert.equal(aiChatSlash.candidates[0].dispatch.handlerId, "new-conversation");
  } finally {
    await fixture.close();
  }
});

test("issue Slash provider filters candidates and maps them to insertText only", async () => {
  const fixture = await createComposerCatalogFixture(async () => [
    { id: "review", label: "/review", description: "Review changes", insertText: "/review " },
    { id: "exec", label: "/exec", description: "Not selectable", insertText: "/exec", selectable: false },
    { id: "INVALID", label: "/INVALID", description: "Invalid id", insertText: "/INVALID" },
  ]);
  try {
    const base = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "/",
      query: "rev",
    });
    const response = await fixture.catalog.candidatesForSurface(base, {
      surface: "comment",
      trigger: "/",
      query: "rev",
    });
    assert.deepEqual(response.candidates.map((candidate) => candidate.command), ["/review"]);
    assert.deepEqual(
      response.candidates[0].selection,
      { type: "insertText", text: "/review " },
    );
    assert.equal("dispatch" in response.candidates[0], false);
  } finally {
    await fixture.close();
  }
});

test("issue Slash has no verified-action fallback when the provider is absent", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    const base = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "/",
      query: "",
    });
    const response = await fixture.catalog.candidatesForSurface(base, {
      surface: "issue-description",
      trigger: "/",
      query: "",
    });
    assert.deepEqual(response.candidates, []);
    assert.deepEqual(
      response.sources.find((source) => source.kind === "slash"),
      { kind: "slash", state: "unavailable", reasonCode: "SOURCE_UNAVAILABLE" },
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate Skill identities are not offered as selectable candidates", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    fixture.setSkills([{ skills: [
      { name: "duplicate", enabled: true, path: "/one/SKILL.md" },
      { name: "duplicate", enabled: true, path: "/two/SKILL.md" },
    ] }]);
    const response = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "@",
      query: "duplicate",
    });
    assert.deepEqual(response.candidates, []);
  } finally {
    await fixture.close();
  }
});

test("persisted composer references rebind without upgrading historical text", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    const skillPersistence = composerReferencePersistence(
      "skill",
      "release-skill",
      "Release Skill",
    );
    const agentPersistence = composerReferencePersistence("agent", "任务总管", "任务总管");
    const rebound = await fixture.catalog.rebindPersistedReferences({
      workspacePath: "/workspace",
      nodes: [
        { type: "text", text: "历史 @master、$release-skill 与 subagent://master 原样保留 " },
        {
          type: "persistedReference",
          referenceKind: "skill",
          referenceKey: skillPersistence.referenceKey,
          label: "旧 Skill 标签",
          stableId: "release-skill",
        },
        {
          type: "persistedReference",
          referenceKind: "agent",
          referenceKey: agentPersistence.referenceKey,
          label: "旧 Agent 标签",
          stableId: "任务总管",
        },
      ],
    });
    assert.equal(rebound.ready, true);
    assert.equal(rebound.document.nodes[0].type, "text");
    assert.match(rebound.document.nodes[0].text, /subagent:\/\/master/);
    assert.deepEqual(
      rebound.document.nodes.slice(1).map(({ type, label }) => ({ type, label })),
      [
        { type: "skill", label: "Release Skill" },
        { type: "agent", label: "任务总管" },
      ],
    );
    assert.deepEqual(rebound.bindings, [
      { nodeIndex: 1, status: "resolved", referenceKind: "skill", label: "Release Skill" },
      { nodeIndex: 2, status: "resolved", referenceKind: "agent", label: "任务总管" },
    ]);
    assert.deepEqual(rebound.diagnostics, []);
    assert.equal(JSON.stringify(rebound).includes("/private/secret"), false);
  } finally {
    await fixture.close();
  }
});

test("composer.v1 turn references still require the current catalog revision", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    const selected = await fixture.catalog.candidates({
      workspacePath: "/workspace",
      trigger: "@",
      query: "release",
    });
    fixture.setSkills([{ skills: [{
      name: "replacement-skill",
      enabled: true,
      path: "/replacement/SKILL.md",
    }] }]);
    await assert.rejects(
      fixture.catalog.resolveReferences({
        workspacePath: "/workspace",
        revision: selected.revision,
        nodes: [{
          type: "skill",
          candidateRef: selected.candidates[0].candidateRef,
          label: selected.candidates[0].label,
        }],
      }),
      (error) => (
        error.code === "COMPOSER_REFERENCE_UNAVAILABLE"
        && error.details.nodeIndex === 0
      ),
    );
  } finally {
    await fixture.close();
  }
});

test("persisted composer rebind reports not found, ambiguous and unavailable sources", async () => {
  const fixture = await createComposerCatalogFixture();
  try {
    const missingAgent = await fixture.catalog.rebindPersistedReferences({
      workspacePath: "/workspace",
      nodes: [{
        type: "persistedReference",
        referenceKind: "agent",
        referenceKey: composerReferencePersistence("agent", "missing", "Missing").referenceKey,
        label: "Missing",
        stableId: "missing",
      }],
    });
    assert.equal(missingAgent.ready, false);
    assert.equal("document" in missingAgent, false);
    assert.equal(missingAgent.bindings[0].reasonCode, "REFERENCE_NOT_FOUND");

    fixture.setSkills([{ skills: [
      { name: "duplicate", enabled: true, path: "/one/SKILL.md" },
      { name: "duplicate", enabled: true, path: "/two/SKILL.md" },
    ] }]);
    const duplicate = await fixture.catalog.rebindPersistedReferences({
      workspacePath: "/workspace",
      nodes: [{
        type: "persistedReference",
        referenceKind: "skill",
        referenceKey: composerReferencePersistence("skill", "duplicate", "Duplicate").referenceKey,
        label: "Duplicate",
        stableId: "duplicate",
      }],
    });
    assert.equal(duplicate.ready, false);
    assert.equal(duplicate.bindings[0].reasonCode, "REFERENCE_AMBIGUOUS");

    fixture.setSkillsError(new Error("skills unavailable"));
    const unavailable = await fixture.catalog.rebindPersistedReferences({
      workspacePath: "/workspace",
      nodes: [{
        type: "persistedReference",
        referenceKind: "skill",
        referenceKey: composerReferencePersistence("skill", "duplicate", "Duplicate").referenceKey,
        label: "Duplicate",
        stableId: "duplicate",
      }],
    });
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.bindings[0].reasonCode, "SOURCE_UNAVAILABLE");
    assert.equal(unavailable.sources.find((source) => source.kind === "skills").state, "unavailable");
  } finally {
    await fixture.close();
  }
});

test("composer reference URI parser rejects noncanonical and unsupported markers", () => {
  assert.throws(
    () => parseComposerReferenceUri("subagent://master"),
    /composer reference v1 URI/,
  );
  assert.throws(
    () => parseComposerReferenceUri("taskboard://composer-reference/v1/plugin/cGx1Z2lu"),
    /skill.*agent/,
  );
  assert.throws(
    () => parseComposerReferenceUri("taskboard://composer-reference/v1/agent/bWFzdGVy="),
    /base64url/,
  );
});

test("composer rebind HTTP API returns send-ready documents and boundary errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-composer-rebind-api-"));
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "app-server") process.exit(2);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize" && message.id !== undefined) {
      process.stdout.write(JSON.stringify({id:message.id,result:{platformFamily:"unix"}}) + "\\n");
    }
    if (message.method === "skills/list" && message.id !== undefined) {
      process.stdout.write(JSON.stringify({id:message.id,result:{data:[{skills:[{
        name:"real-skill",enabled:true,path:"/server-only/real-skill/SKILL.md",
        description:"Real skill",interface:{displayName:"Real Skill"}
      }]}]}}) + "\\n");
    }
    if (message.method === "shutdown" && message.id !== undefined) {
      process.stdout.write(JSON.stringify({id:message.id,result:null}) + "\\n");
    }
  }
});
`);
  await chmod(executable, 0o755);
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    codexExecutable: executable,
    codexStatePath: path.join(directory, "missing-codex-state.json"),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const persistence = composerReferencePersistence("skill", "real-skill", "Real Skill");
    const slashCandidatesResponse = await fetch(
      `${baseUrl}/api/local/ai/composer/candidates?projectId=local&trigger=%2F&query=&surface=issue-description`,
    );
    assert.equal(slashCandidatesResponse.status, 200);
    const slashCandidates = await slashCandidatesResponse.json();
    assert.ok(slashCandidates.candidates.length > 4);
    const newCandidate = slashCandidates.candidates.find((candidate) => candidate.command === "/new");
    assert.deepEqual(newCandidate.selection, { type: "insertText", text: "/new " });
    assert.ok(slashCandidates.candidates.every((candidate) => !("dispatch" in candidate)));

    const aiChatSlashResponse = await fetch(
      `${baseUrl}/api/local/ai/composer/candidates?projectId=local&trigger=%2F&query=&surface=ai-chat`,
    );
    assert.equal(aiChatSlashResponse.status, 200);
    const aiChatSlash = await aiChatSlashResponse.json();
    const verifiedHandlers = new Set([
      "new-conversation",
      "open-model-menu",
      "open-reasoning-menu",
      "compact-conversation",
    ]);
    assert.ok(aiChatSlash.candidates.length > 0);
    assert.ok(aiChatSlash.candidates.every((candidate) => (
      verifiedHandlers.has(candidate.dispatch?.handlerId)
    )));

    const skillCandidatesResponse = await fetch(
      `${baseUrl}/api/local/ai/composer/candidates?projectId=local&trigger=%40&query=real&surface=comment`,
    );
    assert.equal(skillCandidatesResponse.status, 200);
    const skillCandidates = await skillCandidatesResponse.json();
    assert.equal(skillCandidates.candidates[0].persistence.referenceKey, persistence.referenceKey);
    assert.equal(JSON.stringify(skillCandidates).includes("/server-only"), false);

    const response = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        document: {
          version: 1,
          nodes: [
            { type: "text", text: "Use " },
            {
              type: "persistedReference",
              referenceKind: "skill",
              referenceKey: persistence.referenceKey,
              label: "Saved Label",
            },
          ],
        },
      }),
    });
    assert.equal(response.status, 200);
    const rebound = await response.json();
    assert.equal(rebound.ready, true);
    assert.deepEqual(rebound.document.nodes.map((node) => node.type), ["text", "skill"]);
    assert.equal(rebound.bindings[0].label, "Real Skill");
    assert.equal(JSON.stringify(rebound).includes("/server-only"), false);
    assert.equal(
      app.database.database.prepare("SELECT COUNT(*) AS count FROM ai_chat_events").get().count,
      0,
    );

    const unsupportedResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        document: {
          version: 1,
          nodes: [
            {
              type: "unsupportedReference",
              referenceUri: "taskboard://composer-reference/v2/plugin/cGx1Z2lu",
              label: "Future format",
            },
            {
              type: "unsupportedReference",
              referenceUri: "taskboard://composer-reference/v1/plugin/cGx1Z2lu",
              label: "Future kind",
            },
          ],
        },
      }),
    });
    assert.equal(unsupportedResponse.status, 200);
    const unsupported = await unsupportedResponse.json();
    assert.equal(unsupported.ready, false);
    assert.deepEqual(unsupported.bindings, [
      {
        nodeIndex: 0,
        status: "unavailable",
        referenceKind: "unsupported",
        reasonCode: "REFERENCE_FORMAT_UNSUPPORTED",
      },
      {
        nodeIndex: 1,
        status: "unavailable",
        referenceKind: "unsupported",
        reasonCode: "REFERENCE_KIND_UNSUPPORTED",
      },
    ]);

    const invalidResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        document: {
          version: 1,
          nodes: [{
            type: "persistedReference",
            referenceKind: "skill",
            referenceKey: "cmVhbC1za2lsbA==",
            label: "Real Skill",
          }],
        },
      }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error.code, "INVALID_COMPOSER_REBIND_REQUEST");

    const missingProjectResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "missing",
        document: { version: 1, nodes: [{ type: "text", text: "No mutation" }] },
      }),
    });
    assert.equal(missingProjectResponse.status, 400);
    assert.equal((await missingProjectResponse.json()).error.code, "INVALID_COMPOSER_QUERY");

    const authoritativeThread = app.database.createAiChatThread({
      id: "authoritative-composer-thread",
      title: "Authoritative workspace",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: directory,
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const authoritativeThreadResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        threadId: authoritativeThread.id,
        document: {
          version: 1,
          nodes: [{
            type: "persistedReference",
            referenceKind: "skill",
            referenceKey: persistence.referenceKey,
            label: "Real Skill",
          }],
        },
      }),
    });
    assert.equal(authoritativeThreadResponse.status, 200);
    assert.equal((await authoritativeThreadResponse.json()).ready, true);

    const crossProjectThread = app.database.createAiChatThread({
      id: "cross-project-composer-thread",
      title: "Cross project",
      origin: { projectId: "other", projectName: "Other", workspacePath: directory },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const crossProjectThreadResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        threadId: crossProjectThread.id,
        document: { version: 1, nodes: [{ type: "text", text: "No mutation" }] },
      }),
    });
    assert.equal(crossProjectThreadResponse.status, 400);
    assert.equal((await crossProjectThreadResponse.json()).error.code, "INVALID_COMPOSER_QUERY");

    const unavailableThread = app.database.createAiChatThread({
      id: "unavailable-workspace-composer-thread",
      title: "Unavailable workspace",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: path.join(directory, "missing-workspace"),
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    });
    const unavailableThreadResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "local",
        threadId: unavailableThread.id,
        document: { version: 1, nodes: [{ type: "text", text: "No mutation" }] },
      }),
    });
    assert.equal(unavailableThreadResponse.status, 409);
    assert.equal(
      (await unavailableThreadResponse.json()).error.code,
      "PROJECT_WORKSPACE_UNAVAILABLE",
    );

    const createProjectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "unmapped", name: "Unmapped" }),
    });
    assert.equal(createProjectResponse.status, 201);
    const unavailableWorkspaceResponse = await fetch(`${baseUrl}/api/local/ai/composer/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        projectId: "unmapped",
        document: { version: 1, nodes: [{ type: "text", text: "No mutation" }] },
      }),
    });
    assert.equal(unavailableWorkspaceResponse.status, 409);
    assert.equal(
      (await unavailableWorkspaceResponse.json()).error.code,
      "PROJECT_WORKSPACE_UNAVAILABLE",
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalized item events retain a bounded public item id", () => {
  const itemId = "x".repeat(70_000);
  const normalized = normalizeCodexEvent({
    type: "item.updated",
    item: {
      id: itemId,
      type: "command_execution",
      command: "npm test",
      status: "in_progress",
    },
  });

  assert.equal(normalized.data.itemId, itemId.slice(0, 65_536));
});

test("completed item errors are warnings while failed item errors remain errors", () => {
  const completed = normalizeCodexEvent({
    type: "item.completed",
    item: {
      id: "notice",
      type: "error",
      status: "completed",
      message: "Skill descriptions were shortened",
    },
  });
  const failed = normalizeCodexEvent({
    type: "item.completed",
    item: {
      id: "failure",
      type: "error",
      status: "failed",
      message: "Tool failed",
    },
  });

  assert.deepEqual(completed, {
    kind: "event",
    type: "error",
    role: "activity",
    content: "Skill descriptions were shortened",
    data: { status: "warning", itemId: "notice" },
  });
  assert.deepEqual(failed, {
    kind: "event",
    type: "error",
    role: "error",
    content: "Tool failed",
    data: { status: "failed", itemId: "failure" },
  });
});

test("unsupported composer nodes fail with the stable code before a run starts", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    await assert.rejects(
      fixture.service.startTurn(thread.id, {
        contractVersion: "composer.v1",
        revision: "unused",
        document: { version: 1, nodes: [{ type: "unsupportedReference" }] },
      }),
      (error) => error.status === 422 && error.code === "COMPOSER_NODE_UNSUPPORTED",
    );
    assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-runner-"));
  const workspacePath = path.join(directory, "workspace");
  const otherWorkspacePath = path.join(directory, "other-workspace");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspacePath)]);
  const [workspace, otherWorkspace] = await Promise.all([
    realpath(workspacePath),
    realpath(otherWorkspacePath),
  ]);
  const capturePath = path.join(directory, "capture.jsonl");
  const environmentCapturePath = path.join(directory, "environment-capture.jsonl");
  const descendantPath = path.join(directory, "descendant-alive");
  const descendantDelayMs = process.platform === "win32" ? 1_500 : 300;
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.FAKE_ENVIRONMENT_CAPTURE_PATH) {
  appendFileSync(process.env.FAKE_ENVIRONMENT_CAPTURE_PATH, JSON.stringify({
    args,
    launcherKeys: Object.keys(process.env).filter((name) => name.startsWith("CODEX_TASKBOARD_")),
  }) + "\\n");
}
if (args[0] === "debug" && args[1] === "models") {
  if (args.length !== 2) process.exit(2);
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"Real fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}],
    service_tiers:[{id:"priority",name:"Fast",description:"fixture"}]
  }]}));
  process.exit(0);
}
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{"platformFamily":"unix"}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","description":"Real fixture skill","path":"/fixture/real-skill/SKILL.md","interface":{"displayName":"Real Skill"}},{"name":"disabled","enabled":false,"scope":"user"}]}]}}\\n');
    }
  });
} else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-thread-1"});
    emit({type:"turn.started"});
    if (prompt.includes("MALFORMED_STUBBORN") || prompt.includes("CALLBACK_FATAL_STUBBORN")) {
      spawn(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.env.FAKE_DESCENDANT_PATH, "alive"), ${descendantDelayMs}); setInterval(() => {}, 1000)',
      ], {env:process.env,stdio:"ignore"});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      if (prompt.includes("CALLBACK_FATAL_STUBBORN")) {
        emit({type:"thread.started",thread_id:"unexpected-thread"});
      } else {
        process.stdout.write("{not-json}\\n");
      }
      return;
    }
    if (prompt.includes("MALFORMED")) {
      process.stdout.write("{not-json}\\n");
      return;
    }
    emit({type:"item.completed",item:{type:"reasoning",text:"SECRET REASONING"}});
    emit({type:"item.completed",item:{type:"agent_message",text:"Visible answer"}});
    emit({type:"item.completed",item:{type:"command_execution",command:"npm test",status:"completed",exit_code:0,aggregated_output:"ok"}});
    if (prompt.includes("LARGE_COMMAND_OUTPUT")) {
      emit({type:"item.completed",item:{type:"command_execution",command:"large output",status:"completed",exit_code:0,aggregated_output:"x".repeat(1_048_577)}});
    }
    if (prompt.includes("TURN_FAILED_ZERO")) {
      emit({type:"turn.failed",error:{message:"Protocol turn failed"}});
      return;
    }
    if (prompt.includes("ROOT_ERROR_ZERO")) {
      emit({type:"error",message:"Protocol root error"});
      return;
    }
    if (prompt.includes("WARNING_THEN_COMPLETED")) {
      emit({type:"error",message:"Skill descriptions were shortened"});
    }
    if (prompt.includes("NO_TERMINAL")) return;
    if (prompt.includes("ITEM_ERROR")) {
      emit({type:"item.completed",item:{id:"item-error-1",type:"error",message:"Recoverable item error"}});
    }
    if (prompt.includes("WAIT")) {
      const timer = setTimeout(() => { emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}); }, 800);
      process.on("SIGTERM", () => { clearTimeout(timer); process.exit(143); });
      return;
    }
    if (prompt.includes("FAIL")) process.exit(7);
    emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
  });
}
`);
  await chmod(executable, 0o755);

  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      project: { rootPaths: [workspace] },
      other: { rootPaths: [otherWorkspace] },
    },
  }));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  database.createProject({ id: "other", name: "Other", workspacePath: null });
  const service = new AiChatService({
    database,
    codexExecutable: executable,
    codexStatePath,
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
    processEnv: {
      ...process.env,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_DESCENDANT_PATH: descendantPath,
      FAKE_ENVIRONMENT_CAPTURE_PATH: environmentCapturePath,
      CODEX_TASKBOARD_INSTANCE_TOKEN: "must-not-reach-codex",
      CODEX_TASKBOARD_INSTANCE_SECRET: "must-not-reach-codex",
      CODEX_TASKBOARD_PORT: "47823",
      CODEX_TASKBOARD_VERSION: "0.2.0",
    },
    killGraceMs: 50,
  });
  return {
    capturePath,
    database,
    databasePath,
    descendantDelayMs,
    descendantPath,
    directory,
    environmentCapturePath,
    otherWorkspace,
    service,
    workspace,
    async close() {
      await this.service.close();
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events", async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fixture.service.getCatalog("project");
    assert.deepEqual(catalog.models, [{
      slug: "gpt-real",
      displayName: "GPT Real",
      description: "Real fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
    }]);
    assert.deepEqual(catalog.skills, [{
      id: "real-skill",
      label: "Real Skill",
      description: "Real fixture skill",
      path: "/fixture/real-skill/SKILL.md",
      scope: "repo",
    }]);

    const thread = await fixture.service.createThread({
      projectId: "project",
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.workspacePath, fixture.workspace);

    const first = await fixture.service.startTurn(thread.id, {
      message: "HIDDEN_SENTINEL \uFFFC first",
      skillIds: ["real-skill"],
    });
    await waitFor(() => fixture.service.getRun(first.id)?.status !== "running");
    const second = await fixture.service.startTurn(thread.id, { message: "second" });
    await waitFor(() => fixture.service.getRun(second.id)?.status !== "running");

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const environmentCaptures = (
      await readFile(fixture.environmentCapturePath, "utf8")
    ).trim().split("\n").map(JSON.parse);
    assert.ok(environmentCaptures.length >= 3);
    assert.equal(environmentCaptures.every((entry) => entry.launcherKeys.length === 0), true);
    assert.deepEqual(captures[0].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "-",
    ]);
    assert.equal(captures[0].args.join(" ").includes("HIDDEN_SENTINEL"), false);
    assert.match(captures[0].prompt, /\[\$manage-taskboard\]\(\/fixture\/manage-taskboard\/SKILL\.md\) e-taskboard/);
    assert.match(
      captures[0].prompt,
      /HIDDEN_SENTINEL \[\$real-skill\]\(\/fixture\/real-skill\/SKILL\.md\) first/,
    );
    assert.deepEqual(captures[1].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "-c", 'approval_policy="on-request"',
      "-c", 'approvals_reviewer="auto_review"',
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "resume", "codex-thread-1", "-",
    ]);
    assert.equal(captures[1].args.includes("--last"), false);

    const snapshot = fixture.service.getThreadSnapshot(thread.id);
    assert.equal(snapshot.thread.codexThreadId, "codex-thread-1");
    assert.equal(snapshot.events.some((event) => event.content?.includes("SECRET REASONING")), false);
    assert.equal(snapshot.events.some((event) => event.content === "Visible answer"), true);
    assert.equal(snapshot.events.some((event) => event.type === "command_execution"), true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("HIDDEN_SENTINEL"), true);
    assert.equal(serialized.includes("<taskboard_context>"), false);
    const persisted = JSON.stringify(
      fixture.database.database.prepare("SELECT * FROM ai_chat_events").all(),
    );
    assert.equal(persisted.includes("<taskboard_context>"), false);
    assert.equal(persisted.includes("SECRET REASONING"), false);
  } finally {
    await fixture.close();
  }
});

test("same-thread turns are locked, different threads run concurrently, failures and interrupts settle", async () => {
  const fixture = await createFixture();
  try {
    const firstThread = await fixture.service.createThread({ projectId: "project" });
    const secondThread = await fixture.service.createThread({ projectId: "other" });
    const waiting = await fixture.service.startTurn(firstThread.id, { message: "WAIT" });
    await assert.rejects(
      fixture.service.startTurn(firstThread.id, { message: "must reject" }),
      (error) => error.code === "THREAD_BUSY",
    );
    const parallel = await fixture.service.startTurn(secondThread.id, { message: "normal" });
    await waitFor(() => fixture.service.getRun(parallel.id)?.status === "completed");
    const interrupted = await fixture.service.interrupt(waiting.id);
    assert.equal(interrupted.id, waiting.id);
    await waitFor(() => fixture.service.getRun(waiting.id)?.status === "interrupted");

    const failed = await fixture.service.startTurn(firstThread.id, { message: "FAIL" });
    await waitFor(() => fixture.service.getRun(failed.id)?.status === "failed");
    assert.equal(fixture.service.getRun(failed.id).exitCode, 7);
    assert.equal(
      fixture.service.getThreadSnapshot(firstThread.id).events.some(
        (event) => event.role === "error" && event.content.includes("code 7"),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("malformed Codex JSONL fails the run", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "MALFORMED" });
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");

    const failed = fixture.service.getRun(run.id);
    assert.equal(failed.error, "Codex emitted malformed JSONL");
    assert.equal(
      fixture.service.getThreadSnapshot(thread.id).events.some(
        (event) => event.role === "error"
          && event.content === "Codex emitted malformed JSONL",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("parser and event callback failures kill a SIGTERM-resistant process group", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedError] of [
      ["MALFORMED_STUBBORN", "Codex emitted malformed JSONL"],
      ["CALLBACK_FATAL_STUBBORN", "Codex returned an unexpected thread id"],
    ]) {
      await rm(fixture.descendantPath, { force: true });
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status === "failed");
      assert.equal(fixture.service.getRun(run.id).error, expectedError);
      await new Promise((resolve) => setTimeout(resolve, fixture.descendantDelayMs + 50));
      await assert.rejects(readFile(fixture.descendantPath), (error) => error.code === "ENOENT");
    }
  } finally {
    await fixture.close();
  }
});

test("protocol terminal events determine run success and item errors remain non-fatal", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedStatus] of [
      ["TURN_FAILED_ZERO", "failed"],
      ["ROOT_ERROR_ZERO", "failed"],
      ["NO_TERMINAL", "failed"],
      ["ITEM_ERROR", "completed"],
      ["WARNING_THEN_COMPLETED", "completed"],
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status !== "running");
      assert.equal(fixture.service.getRun(run.id).status, expectedStatus, message);
    }
  } finally {
    await fixture.close();
  }
});

test("a root Codex error remains the run diagnostic when completion never arrives", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "ROOT_ERROR_ZERO" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    const finished = fixture.service.getRun(run.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.error, "Protocol root error");
  } finally {
    await fixture.close();
  }
});

test("a root Codex error preceding completion is recorded as a warning", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "WARNING_THEN_COMPLETED" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    const warning = fixture.service.getThreadSnapshot(thread.id).events.find(
      (event) => event.type === "error" && event.content === "Skill descriptions were shortened",
    );
    assert.equal(fixture.service.getRun(run.id).status, "completed");
    assert.equal(warning?.role, "activity");
    assert.equal(warning?.data.status, "warning");
  } finally {
    await fixture.close();
  }
});

test("a Codex command event slightly over one MiB completes and keeps only bounded output", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "LARGE_COMMAND_OUTPUT" });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    assert.equal(fixture.service.getRun(run.id).status, "completed");
    const largeOutputEvent = fixture.service.getThreadSnapshot(thread.id).events.find(
      (event) => event.type === "command_execution" && event.content === "large output",
    );
    assert.equal(largeOutputEvent.data.output.length, 65_536);
  } finally {
    await fixture.close();
  }
});

test("startTurn revalidates the latest danger sandbox and persisted model settings", async () => {
  const fixture = await createFixture();
  try {
    for (const scenario of [
      {
        changes: { sandbox: "danger-full-access" },
        expectedCode: "DANGER_CONFIRMATION_REQUIRED",
      },
      {
        changes: { model: "retired-model" },
        expectedCode: "INVALID_MODEL",
      },
      {
        changes: { reasoningEffort: "ultra" },
        expectedCode: "INVALID_REASONING_EFFORT",
      },
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
      let releaseCatalog;
      let catalogRequested = false;
      const catalogGate = new Promise((resolve) => {
        releaseCatalog = resolve;
      });
      fixture.service.getCatalog = async (...args) => {
        catalogRequested = true;
        await catalogGate;
        return originalGetCatalog(...args);
      };

      const pending = fixture.service.startTurn(thread.id, { message: "must not spawn" });
      await waitFor(() => catalogRequested);
      fixture.database.updateAiChatThread(thread.id, scenario.changes);
      releaseCatalog();
      await assert.rejects(pending, (error) => error.code === scenario.expectedCode);
      assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
      fixture.service.getCatalog = originalGetCatalog;
    }
  } finally {
    await fixture.close();
  }
});

test("startup marks abandoned runs interrupted while preserving the Codex thread id", async () => {
  const fixture = await createFixture();
  const thread = await fixture.service.createThread({ projectId: "project" });
  fixture.database.database.prepare(
    "UPDATE ai_chat_threads SET codex_thread_id = ?, status = 'running' WHERE id = ?",
  ).run("preserved-session", thread.id);
  fixture.database.database.prepare(`
    INSERT INTO ai_chat_runs (
      id, thread_id, status, exit_code, error, started_at, finished_at
    ) VALUES ('abandoned', ?, 'running', NULL, NULL, ?, NULL)
  `).run(thread.id, new Date().toISOString());
  await fixture.service.close();
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.databasePath);
  const restarted = new AiChatService({
    database: fixture.database,
    codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
    codexStatePath: path.join(fixture.directory, "codex-state.json"),
    manageTaskboardSkillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  fixture.service = restarted;
  try {
    assert.equal(restarted.getRun("abandoned").status, "interrupted");
    assert.equal(restarted.getThread(thread.id).codexThreadId, "preserved-session");
  } finally {
    await fixture.close();
  }
});
