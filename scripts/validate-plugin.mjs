#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_NAME = path.basename(ROOT);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInsideRoot(relativePath, label) {
  check(typeof relativePath === "string" && relativePath.startsWith("./"), `${label} must start with './'.`);
  const resolved = path.resolve(ROOT, relativePath);
  check(
    resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`),
    `${label} must stay inside the repository.`,
  );
  check(existsSync(resolved), `${label} points to a missing path.`);
  return resolved;
}

function validateRepositoryPlugin() {
  const packageJson = readJson("package.json");
  const manifest = readJson(".codex-plugin/plugin.json");
  const mcpManifest = readJson(".mcp.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");

  check(manifest.name === PLUGIN_NAME, "Plugin name must match the repository directory.");
  check(manifest.version === packageJson.version, "Plugin and package versions must match.");
  check(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version), "Plugin version must be semver.");
  check(manifest.license === "UNLICENSED", "Private repository license metadata must remain explicit.");
  check(manifest.skills === "./skills/", "Plugin must expose the repository Skills.");
  check(manifest.mcpServers === "./.mcp.json", "Plugin must reference the MCP manifest.");
  resolveInsideRoot(manifest.skills, "skills");
  resolveInsideRoot(manifest.mcpServers, "mcpServers");

  const mcp = mcpManifest.mcpServers?.[PLUGIN_NAME];
  check(mcp?.command === "dashi-taskboard-mcp", "MCP manifest must invoke the npm bin.");
  check(Array.isArray(mcp.args) && mcp.args.length === 0, "MCP bin must not depend on local path arguments.");
  check(
    packageJson.bin?.["dashi-taskboard-mcp"] === "./mcp/server.mjs",
    "Package must expose mcp/server.mjs as dashi-taskboard-mcp.",
  );
  resolveInsideRoot(packageJson.bin["dashi-taskboard-mcp"], "MCP bin");

  const entry = marketplace.plugins?.find((plugin) => plugin.name === PLUGIN_NAME);
  check(entry?.source?.source === "local", "Marketplace plugin source must be local.");
  check(entry.source.path === "./", "Marketplace must expose the repository-root plugin.");
  resolveInsideRoot(entry.source.path, "Marketplace source");
  check(entry.policy?.installation === "AVAILABLE", "Marketplace installation policy must be AVAILABLE.");
  check(entry.policy?.authentication === "ON_INSTALL", "Marketplace auth policy must be ON_INSTALL.");
  check(entry.category === "Productivity", "Marketplace category must be Productivity.");
}

function runPythonValidator(script, args) {
  const result = spawnSync("python3", [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  check(result.status === 0, `${path.basename(script)} failed.`);
}

function runInstalledCodexValidators() {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) {
    console.log("CODEX_HOME is not set; skipped installed Codex validators.");
    return;
  }

  const pluginValidator = path.join(
    codexHome,
    "skills",
    ".system",
    "plugin-creator",
    "scripts",
    "validate_plugin.py",
  );
  const skillValidator = path.join(
    codexHome,
    "skills",
    ".system",
    "skill-creator",
    "scripts",
    "quick_validate.py",
  );
  if (existsSync(pluginValidator)) runPythonValidator(pluginValidator, [ROOT]);
  else console.log("Installed plugin validator not found; repository checks still passed.");

  if (!existsSync(skillValidator)) {
    console.log("Installed Skill validator not found; repository checks still passed.");
    return;
  }
  const skillsRoot = path.join(ROOT, "skills");
  for (const name of readdirSync(skillsRoot).sort()) {
    const skillRoot = path.join(skillsRoot, name);
    if (statSync(skillRoot).isDirectory()) runPythonValidator(skillValidator, [skillRoot]);
  }
}

validateRepositoryPlugin();
console.log(`Repository plugin validation passed: ${PLUGIN_NAME}`);
runInstalledCodexValidators();
