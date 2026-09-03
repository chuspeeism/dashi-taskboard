#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productName = process.env.CODEX_TASKBOARD_RELEASE_VERSION?.includes("-beta.")
  ? "Atlas Workbench Beta"
  : "Atlas Workbench";
const tauriCli = path.join(projectRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const result = spawnSync(
  process.execPath,
  [tauriCli, "build", ...process.argv.slice(2), "--config", JSON.stringify({ productName })],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
