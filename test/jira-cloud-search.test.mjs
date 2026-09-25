import test from "node:test";
import assert from "node:assert/strict";

import { createJiraIntegration } from "../server/jira-integration.mjs";

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "duedate",
  "assignee",
  "reporter",
  "created",
  "updated",
];

const input = {
  baseUrl: "https://example.atlassian.net",
  username: "reader@example.com",
  password: "test-api-token",
  projects: ["DEMO"],
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("configures Jira Cloud and force-syncs all enhanced-search pages", async () => {
  let storedConfig = null;
  const validateCalls = [];
  const searchRequests = [];
  const syncCalls = [];

  const configStore = {
    async read() {
      return storedConfig;
    },
    validate(config) {
      validateCalls.push(config);
      return config;
    },
    async save(config) {
      storedConfig = { ...config, version: 2 };
      return storedConfig;
    },
  };

  const database = {
    syncJiraTasks(tasks, options) {
      syncCalls.push({ tasks, options });
    },
  };

  const fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    const headers = init?.headers ?? {};
    assert.equal(headers.accept, "application/json");
    assert.equal(
      headers.authorization,
      `Basic ${Buffer.from("reader@example.com:test-api-token", "utf8").toString("base64")}`,
    );

    if (pathname === "/rest/applinks/1.0/manifest") {
      return response({ id: "test-jira-instance" });
    }
    if (pathname === "/rest/api/2/myself") {
      return response({ displayName: "Test Reader" });
    }
    if (pathname === "/rest/api/2/search") {
      return response(null, 410);
    }
    if (pathname !== "/rest/api/2/search/jql") {
      assert.fail(`Unexpected Jira URL: ${pathname}`);
    }

    assert.equal(init.method, "POST");
    assert.equal(headers["content-type"], "application/json");
    const body = JSON.parse(init.body);
    const firstPage = searchRequests.length % 2 === 0;
    searchRequests.push({ pathname, body });

    assert.equal(body.jql, 'assignee = currentUser() AND project in ("DEMO") AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC');
    assert.equal(body.maxResults, 100);
    assert.deepEqual(body.fields, JIRA_FIELDS);
    if (firstPage) {
      assert.equal(Object.hasOwn(body, "startAt"), false);
      assert.equal(Object.hasOwn(body, "nextPageToken"), false);
      return response({
        isLast: false,
        nextPageToken: "page-2",
        issues: [{
          id: "10001",
          key: "DEMO-1",
          fields: { summary: "First page", description: "First description" },
        }],
      });
    }

    assert.equal(body.nextPageToken, "page-2");
    assert.equal(Object.hasOwn(body, "startAt"), false);
    return response({
      isLast: true,
      issues: [{
        id: "10002",
        key: "DEMO-2",
        fields: { summary: "Second page", description: "Second description" },
      }],
    });
  };

  const jira = createJiraIntegration({ configStore, database, fetch });
  const connection = await jira.configure(input);
  await jira.sync({ force: true });

  assert.deepEqual(validateCalls, [input]);
  assert.equal(storedConfig.version, 2);
  assert.equal(connection.configured, true);
  assert.equal(searchRequests.length, 4);
  assert.deepEqual(
    searchRequests.map(({ pathname }) => pathname),
    ["/rest/api/2/search/jql", "/rest/api/2/search/jql", "/rest/api/2/search/jql", "/rest/api/2/search/jql"],
  );
  assert.equal(syncCalls.length, 2);
  for (const { tasks } of syncCalls) {
    assert.deepEqual(tasks.map((task) => task.externalKey), ["DEMO-1", "DEMO-2"]);
    assert.deepEqual(tasks.map((task) => task.title), ["First page", "Second page"]);
    assert.deepEqual(tasks.map((task) => task.description), ["First description", "Second description"]);
  }
});
