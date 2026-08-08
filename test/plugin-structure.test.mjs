import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(REPO_ROOT, relativePath), "utf8"));
}

test("official plugin manifest exposes the repository Skills and MCP server", async () => {
  const manifest = await readJson(".codex-plugin/plugin.json");
  const packageJson = await readJson("package.json");

  assert.equal(manifest.name, path.basename(REPO_ROOT));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.repository, "https://github.com/chuspeeism/dashi-taskboard");
  assert.equal(manifest.license, "UNLICENSED");
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);

  for (const referencedPath of [manifest.skills, manifest.mcpServers]) {
    await access(path.resolve(REPO_ROOT, referencedPath));
  }
});

test("MCP manifest invokes the portable npm bin without local paths or credentials", async () => {
  const mcpManifest = await readJson(".mcp.json");
  const packageJson = await readJson("package.json");

  assert.deepEqual(mcpManifest, {
    mcpServers: {
      "dashi-taskboard": {
        command: "dashi-taskboard-mcp",
        args: [],
      },
    },
  });
  assert.equal(packageJson.bin["dashi-taskboard-mcp"], "./mcp/server.mjs");
  assert.equal(packageJson.scripts["plugin:validate"], "node scripts/validate-plugin.mjs");
  assert.doesNotMatch(JSON.stringify(mcpManifest), /authorization|password|token|workspacePath|\/home\//i);
  await access(path.resolve(REPO_ROOT, packageJson.bin["dashi-taskboard-mcp"]));
  await access(path.join(REPO_ROOT, "scripts", "validate-plugin.mjs"));
});

test("repository marketplace makes the root plugin available with install-time auth", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "dashi-taskboard-local");
  assert.equal(typeof marketplace.interface.displayName, "string");
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: "dashi-taskboard",
    source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  });
  assert.equal(
    marketplace.plugins[0].name,
    (await readJson(".codex-plugin/plugin.json")).name,
  );
  await access(path.resolve(REPO_ROOT, marketplace.plugins[0].source.path));
});
