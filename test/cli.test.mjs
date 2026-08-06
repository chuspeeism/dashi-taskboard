import assert from "node:assert/strict";
import test from "node:test";

import { main, parseArgs } from "../cli/taskctl.mjs";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    json() { return JSON.parse(value); },
    text() { return value; },
  };
}

async function runRaw(argv, overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    fetch: async () => assert.fail("help must not call the service"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
    ...overrides,
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(argv, fetchImplementation, overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    fetch: fetchImplementation,
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { CODEX_THREAD_ID: "thread-current" },
    ...overrides,
  });
  return {
    exitCode,
    stdout: exitCode === 0 ? stdout.json() : null,
    stderr: exitCode === 0 ? null : stderr.json(),
  };
}

test("parseArgs supports equals syntax and boolean --json", () => {
  assert.deepEqual(parseArgs(["issue", "list", "--project=local", "--json"]), {
    resource: "issue",
    action: "list",
    operands: [],
    options: { project: "local", json: true },
  });
});

test("project list uses the default local service and adds schemaVersion", async () => {
  const calls = [];
  const result = await run(["project", "list"], async (url, init) => {
    calls.push({ url: url.toString(), init });
    return response({ projects: [{ id: "local", name: "Local" }] });
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, {
    projects: [{ id: "local", name: "Local" }],
    schemaVersion: 2,
  });
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/projects");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "taskctl");
});

test("CODEX_TASKBOARD_URL overrides the service origin", async () => {
  let requestedUrl;
  const result = await run(
    ["project", "list", "--json"],
    async (url) => {
      requestedUrl = url;
      return response({ projects: [] });
    },
    { env: { CODEX_TASKBOARD_URL: "https://tasks.example.test/" } },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.toString(), "https://tasks.example.test/api/projects");
});

test("project create sends id, name, and an absolute workspace path", async () => {
  let requestBody;
  const result = await run(
    ["project", "create", "--id", "docs", "--name", "Docs", "--workspace-path", "./docs"],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ project: { id: "docs", name: "Docs" } }, 201);
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestBody.id, "docs");
  assert.equal(requestBody.name, "Docs");
  assert.equal(requestBody.workspacePath.endsWith("/docs"), true);
});

test("issue list serializes project and status filters", async () => {
  let requestedUrl;
  const result = await run(
    ["issue", "list", "--project", "local", "--status", "todo"],
    async (url) => {
      requestedUrl = url;
      return response({ tasks: [] });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl.searchParams.get("projectId"), "local");
  assert.equal(requestedUrl.searchParams.get("status"), "todo");
});

test("issue commands accept in-review, blocked, and canceled statuses", async () => {
  for (const status of ["in_review", "blocked", "canceled"]) {
    let requestedUrl;
    const listResult = await run(["issue", "list", "--status", status], async (url) => {
      requestedUrl = url;
      return response({ tasks: [] });
    });
    assert.equal(listResult.exitCode, 0);
    assert.equal(requestedUrl.searchParams.get("status"), status);
  }

  let createBody;
  const createResult = await run(
    ["issue", "create", "--project", "local", "--title", "Review me", "--status", "in_review"],
    async (_url, init) => {
      createBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...createBody, version: 1 } }, 201);
    },
  );
  assert.equal(createResult.exitCode, 0);
  assert.equal(createBody.status, "in_review");

  let moveBody;
  const moveResult = await run(
    ["issue", "move", "TASK-1", "--status", "blocked", "--if-version", "1"],
    async (_url, init) => {
      moveBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", status: "blocked", version: 2 } });
    },
  );
  assert.equal(moveResult.exitCode, 0);
  assert.equal(moveBody.status, "blocked");

  let updateBody;
  const updateResult = await run(
    ["issue", "update", "TASK-1", "--status", "canceled", "--if-version", "2"],
    async (_url, init) => {
      updateBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", status: "canceled", version: 3 } });
    },
  );
  assert.equal(updateResult.exitCode, 0);
  assert.equal(updateBody.status, "canceled");
});

test("invalid status errors list every accepted status", async () => {
  const result = await run(
    ["issue", "list", "--status", "started"],
    async () => assert.fail("fetch should not be called"),
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.error.message, /in_review/);
  assert.match(result.stderr.error.message, /blocked/);
  assert.match(result.stderr.error.message, /canceled/);
});

test("issue create reads a description file and parses labels", async () => {
  let requestBody;
  const result = await run(
    [
      "issue",
      "create",
      "--project",
      "local",
      "--title",
      "Fix auth",
      "--description-file",
      "issue.md",
      "--labels",
      "bug, auth,bug",
    ],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...requestBody, version: 1 } }, 201);
    },
    { readFile: async () => "Acceptance criteria" },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    projectId: "local",
    title: "Fix auth",
    description: "Acceptance criteria",
    status: "backlog",
    priority: "none",
    labels: ["bug", "auth"],
    threadId: "thread-current",
  });
});

test("issue update sends an explicit optimistic concurrency version", async () => {
  const calls = [];
  const result = await run(
    ["issue", "update", "TASK/1", "--title", "New title", "--if-version", "7"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ task: { id: "TASK/1", title: "New title", version: 8 } });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "New title",
    threadId: "thread-current",
    version: 7,
  });
});

test("issue update binds one worktree context", async () => {
  let requestBody;
  const result = await run(
    [
      "issue", "update", "TASK-1",
      "--worktree-path", "../taskboard-worktree",
      "--worktree-branch", "worktree/taskboard",
      "--if-version", "4",
    ],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", ...requestBody, version: 5 } });
    },
    { cwd: "/work/repo" },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, {
    developmentContext: {
      type: "worktree",
      path: "/work/taskboard-worktree",
      branch: "worktree/taskboard",
    },
    threadId: "thread-current",
    version: 4,
  });
});

test("issue update rejects simultaneous branch and worktree bindings", async () => {
  let called = false;
  const result = await run(
    ["issue", "update", "TASK-1", "--git-branch", "feature/taskboard", "--worktree-path", "../taskboard-worktree"],
    async () => {
      called = true;
      return response({});
    },
    { cwd: "/work/repo" },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, false);
  assert.match(result.stderr.error.message, /either --git-branch or --worktree-path/);
});

test("issue move fetches the current version when --if-version is omitted", async () => {
  const calls = [];
  const result = await run(["issue", "move", "TASK-1", "--status", "done"], async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return response({ task: { id: "TASK-1", version: 3 } });
    return response({ task: { id: "TASK-1", status: "done", version: 4 } });
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    status: "done",
    threadId: "thread-current",
    version: 3,
  });
});

test("an explicit --thread-id overrides CODEX_THREAD_ID on issue writes", async () => {
  let requestBody;
  const result = await run(
    ["issue", "update", "TASK-1", "--title", "Attributed", "--thread-id", "thread-9", "--if-version", "2"],
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", threadId: "thread-9", version: 3 } });
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, { title: "Attributed", threadId: "thread-9", version: 2 });
  assert.equal(result.stdout.task.threadId, "thread-9");
});

test("issue restore uses the mutation thread and optimistic version", async () => {
  let requestBody;
  const result = await run(
    ["issue", "restore", "TASK-1", "--if-version", "5"],
    async (url, init) => {
      assert.equal(url.pathname, "/api/tasks/TASK-1/restore");
      requestBody = JSON.parse(init.body);
      return response({ task: { id: "TASK-1", threadId: "thread-current", version: 6 } });
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requestBody, { threadId: "thread-current", version: 5 });
});

test("issue relation add and remove use typed relation endpoints", async () => {
  const calls = [];
  const addResult = await run(
    [
      "issue", "relation", "add", "TASK/1",
      "--type", "blocked_by",
      "--issue", "TASK/2",
      "--if-version", "4",
    ],
    async (url, init) => {
      calls.push({ url, init });
      return response({
        task: { id: "TASK/1", version: 5 },
        relatedTask: { id: "TASK/2", version: 2 },
      });
    },
  );
  const removeResult = await run(
    [
      "issue", "relation", "remove", "TASK/1",
      "--type", "related",
      "--issue", "TASK/3",
      "--if-version", "5",
    ],
    async (url, init) => {
      calls.push({ url, init });
      return response({
        task: { id: "TASK/1", version: 6 },
        relatedTask: { id: "TASK/3", version: 1 },
      });
    },
  );

  assert.equal(addResult.exitCode, 0);
  assert.equal(removeResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1/relations/blocked_by/TASK%2F2");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    threadId: "thread-current",
    version: 4,
  });
  assert.equal(calls[1].url.pathname, "/api/tasks/TASK%2F1/relations/related/TASK%2F3");
  assert.equal(calls[1].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    threadId: "thread-current",
    version: 5,
  });
});

test("issue relation validates its action and relation type before fetching", async () => {
  for (const argv of [
    ["issue", "relation", "replace", "TASK-1", "--type", "related", "--issue", "TASK-2"],
    ["issue", "relation", "add", "TASK-1", "--type", "duplicate", "--issue", "TASK-2"],
    ["issue", "relation", "add", "TASK-1", "--type", "related"],
  ]) {
    const result = await run(argv, async () => assert.fail("fetch should not be called"));
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr.error.code, "USAGE_ERROR");
  }
});

test("comment list and add use the issue comments endpoint", async () => {
  const calls = [];
  const listResult = await run(["comment", "list", "TASK/1"], async (url, init) => {
    calls.push({ url, init });
    return response({ comments: [] });
  });
  const addResult = await run(
    ["comment", "add", "TASK/1", "--body", "Verified locally"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ comment: { id: "comment-1", body: "Verified locally", version: 1 } }, 201);
    },
  );

  assert.equal(listResult.exitCode, 0);
  assert.equal(addResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/tasks/TASK%2F1/comments");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url.pathname, "/api/tasks/TASK%2F1/comments");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    body: "Verified locally",
    threadId: "thread-current",
  });
});

test("comment update and delete require an explicit version", async () => {
  const calls = [];
  const updateResult = await run(
    ["comment", "update", "comment/1", "--body", "Updated", "--if-version", "3"],
    async (url, init) => {
      calls.push({ url, init });
      return response({ comment: { id: "comment/1", body: "Updated", version: 4 } });
    },
  );
  const deleteResult = await run(
    ["comment", "delete", "comment/1", "--if-version", "4"],
    async (url, init) => {
      calls.push({ url, init });
      return response({});
    },
  );

  assert.equal(updateResult.exitCode, 0);
  assert.equal(deleteResult.exitCode, 0);
  assert.equal(calls[0].url.pathname, "/api/comments/comment%2F1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    body: "Updated",
    threadId: "thread-current",
    version: 3,
  });
  assert.equal(calls[1].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[1].init.body), { threadId: "thread-current", version: 4 });

  const missingVersion = await run(
    ["comment", "delete", "comment-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(missingVersion.exitCode, 2);
  assert.match(missingVersion.stderr.error.message, /--if-version/);
});

test("context current selects the project with the most specific matching workspace", async () => {
  const result = await run(
    ["context", "current", "--cwd", "/work/repo/packages/app"],
    async () => response({ projects: [
      { id: "local", name: "Local", workspacePath: null },
      { id: "repo", workspacePath: "/work/repo" },
      { id: "app", workspacePath: "/work/repo/packages/app" },
    ] }),
    { cwd: "/unused" },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.cwd, "/work/repo/packages/app");
  assert.deepEqual(result.stdout.project, { id: "app", workspacePath: "/work/repo/packages/app" });
});

test("context current falls back to the local project", async () => {
  const result = await run(
    ["context", "current", "--cwd", "/unmatched"],
    async () => response({ projects: [
      { id: "other", workspacePath: "/work/other" },
      { id: "local", name: "Local", workspacePath: null },
    ] }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.project.id, "local");
});

test("issue and comment writes require Codex conversation attribution", async () => {
  const issueResult = await run(
    ["issue", "update", "TASK-1", "--title", "No attribution", "--if-version", "1"],
    async () => assert.fail("fetch should not be called"),
    { env: {} },
  );
  assert.equal(issueResult.exitCode, 2);
  assert.match(issueResult.stderr.error.message, /--thread-id or CODEX_THREAD_ID/);

  const commentResult = await run(
    ["comment", "add", "TASK-1", "--body", "No attribution"],
    async () => assert.fail("fetch should not be called"),
    { env: {} },
  );
  assert.equal(commentResult.exitCode, 2);
  assert.match(commentResult.stderr.error.message, /--thread-id or CODEX_THREAD_ID/);
});

test("manual linked-thread options and commands are no longer accepted", async () => {
  const optionResult = await run(
    ["issue", "update", "TASK-1", "--title", "Invalid", "--linked-thread-id", "thread-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(optionResult.exitCode, 2);
  assert.match(optionResult.stderr.error.message, /Unknown option --linked-thread-id/);

  const commandResult = await run(
    ["issue", "link-thread", "TASK-1", "--thread-id", "thread-1"],
    async () => assert.fail("fetch should not be called"),
  );
  assert.equal(commandResult.exitCode, 2);
  assert.match(commandResult.stderr.error.message, /Expected one of/);
});

test("API conflicts produce stable JSON on stderr and exit code 5", async () => {
  const result = await run(
    ["issue", "archive", "TASK-1", "--if-version", "1"],
    async () => response({ error: { code: "VERSION_CONFLICT", message: "Task changed" } }, 409),
  );

  assert.equal(result.exitCode, 5);
  assert.deepEqual(result.stderr, {
    schemaVersion: 2,
    error: { code: "VERSION_CONFLICT", message: "Task changed" },
  });
});

test("--help prints text help for every command group on stdout and exits 0", async () => {
  const result = await runRaw(["--help"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  for (const command of [
    "project list",
    "project create",
    "project map",
    "cloud login",
    "cloud status",
    "cloud logout",
    "issue list",
    "issue get",
    "issue create",
    "issue update",
    "issue move",
    "issue archive",
    "issue restore",
    "issue relation",
    "comment list",
    "comment add",
    "comment update",
    "comment delete",
    "attachment download",
    "context current",
  ]) {
    assert.match(result.stdout, new RegExp(command), `help omits ${command}`);
  }
});

test("-h is an alias for --help", async () => {
  const short = await runRaw(["-h"]);
  const long = await runRaw(["--help"]);

  assert.equal(short.exitCode, 0);
  assert.equal(short.stdout, long.stdout);
});

test("the help subcommand prints the same help as --help", async () => {
  const subcommand = await runRaw(["help"]);
  const flag = await runRaw(["--help"]);

  assert.equal(subcommand.exitCode, 0);
  assert.equal(subcommand.stdout, flag.stdout);
});

test("a bare invocation prints top-level help instead of erroring", async () => {
  const bare = await runRaw([]);
  const flag = await runRaw(["--help"]);

  assert.equal(bare.exitCode, 0);
  assert.equal(bare.stderr, "");
  assert.equal(bare.stdout, flag.stdout);
});

test("help <resource> <action> prints that command's own option list", async () => {
  const result = await runRaw(["help", "issue", "create"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /taskctl issue create/);
  for (const signature of [
    "--project PROJECT_ID",
    "--title TITLE",
    "--description TEXT",
    "--description-file FILE",
    "--status STATUS",
    "--priority PRIORITY",
    "--labels a,b",
    "--thread-id ID",
    "--git-branch BRANCH",
    "--worktree-path PATH",
    "--worktree-branch BRANCH",
    "--due-date YYYY-MM-DD",
    "--recurrence-interval N",
    "--recurrence-unit day|week|month|year",
    "--json",
  ]) {
    assert.ok(result.stdout.includes(signature), `issue create help omits ${signature}`);
  }
  assert.ok(
    !result.stdout.includes("attachment download"),
    "command help must not fall back to the full command list",
  );
});

test("help for an unknown command reports a usage error on stderr", async () => {
  const result = await runRaw(["help", "issue", "teleport"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "USAGE_ERROR");
  assert.match(JSON.parse(result.stderr).error.message, /issue teleport/);
});

test("--help --json emits a structured help object with schemaVersion", async () => {
  const result = await runRaw(["--help", "--json"]);

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 2);
  assert.deepEqual(
    payload.help.commands.map((entry) => entry.command),
    [
      "project list",
      "project create",
      "project map",
      "cloud login",
      "cloud status",
      "cloud logout",
      "issue list",
      "issue get",
      "issue create",
      "issue update",
      "issue move",
      "issue archive",
      "issue restore",
      "issue relation",
      "comment list",
      "comment add",
      "comment update",
      "comment delete",
      "attachment download",
      "context current",
    ],
  );

  const create = payload.help.commands.find((entry) => entry.command === "issue create");
  assert.deepEqual(create.options.filter((option) => option.required).map((o) => o.name), [
    "project",
    "title",
  ]);
  assert.deepEqual(create.options.map((option) => option.name).sort(), [
    "description",
    "description-file",
    "due-date",
    "git-branch",
    "json",
    "labels",
    "priority",
    "project",
    "recurrence-interval",
    "recurrence-unit",
    "status",
    "thread-id",
    "title",
    "worktree-branch",
    "worktree-path",
  ]);
});

test("every option advertised by help is actually accepted by that command", async () => {
  const { help } = JSON.parse((await runRaw(["--help", "--json"])).stdout);

  for (const entry of help.commands) {
    const [resource, action] = entry.command.split(" ");
    for (const option of entry.options) {
      const argv = [resource, action, `--${option.name}`];
      if (option.value !== null) argv.push("placeholder");
      const result = await run(argv, async () => response({}));
      if (result.exitCode !== 0) {
        // "Unknown option" means help advertises an option the command rejects.
        // "requires a value" means help mis-classified a value option as a flag.
        assert.ok(
          !/Unknown option|requires a value/.test(result.stderr.error.message),
          `${entry.command} rejects the advertised --${option.name}: `
            + result.stderr.error.message,
        );
      }
    }
  }
});

test("--help after a command scopes help to that command", async () => {
  const flag = await runRaw(["issue", "create", "--help"]);
  const subcommand = await runRaw(["help", "issue", "create"]);

  assert.equal(flag.exitCode, 0);
  assert.equal(flag.stdout, subcommand.stdout);
});

test("help <command> --json narrows the structured payload to that command", async () => {
  const result = await runRaw(["help", "comment", "update", "--json"]);

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.help.commands.length, 1);
  assert.equal(payload.help.commands[0].command, "comment update");
  assert.equal(payload.help.commands[0].operands, "COMMENT_ID");
  assert.deepEqual(
    payload.help.commands[0].options.filter((option) => option.required).map((o) => o.name),
    ["body", "if-version"],
  );
});

test("boolean flags parse without a value while value options still require one", () => {
  assert.deepEqual(parseArgs(["--help"]).options, { help: true });
  assert.deepEqual(parseArgs(["-h"]).options, { help: true });
  assert.deepEqual(parseArgs(["issue", "list", "--json"]).options, { json: true });
  assert.deepEqual(parseArgs(["issue", "list", "--json", "--status", "todo"]).options, {
    json: true,
    status: "todo",
  });

  for (const argv of [["--help=true"], ["issue", "list", "--json=true"]]) {
    assert.throws(() => parseArgs(argv), /does not accept a value/);
  }
  assert.throws(() => parseArgs(["issue", "list", "--status"]), /requires a value/);
});

test("usage errors are stable and never call the service", async () => {
  const result = await run(
    ["issue", "create", "--project", "local"],
    async () => assert.fail("fetch should not be called"),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr.error.code, "USAGE_ERROR");
  assert.match(result.stderr.error.message, /--title/);
});
