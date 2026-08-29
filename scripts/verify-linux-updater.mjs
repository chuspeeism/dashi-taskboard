#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const debPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const appImagePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const latestPath = process.argv[4] ? path.resolve(process.argv[4]) : null;
const releaseTag = process.argv[5]?.trim();
if (!debPath || !appImagePath || !latestPath || !releaseTag) {
  throw new Error(
    "Usage: verify-linux-updater.mjs <package.deb> <package.AppImage> <latest.json> <release-tag>",
  );
}

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "tauri.conf.json"),
  "utf8",
));
if (releaseTag !== `v${packageJson.version}`) {
  throw new Error("Release tag does not match package.json version");
}

const latest = JSON.parse(await readFile(latestPath, "utf8"));
if (latest.version !== packageJson.version) throw new Error("latest.json version is incorrect");
if (latest.platforms?.["linux-x86_64"]) {
  throw new Error("latest.json must use installer-specific Linux updater entries");
}

for (const [platformKey, artifactPath] of [
  ["linux-x86_64-deb", debPath],
  ["linux-x86_64-appimage", appImagePath],
]) {
  const signature = await readFile(`${artifactPath}.sig`, "utf8");
  await verifyUpdaterSignature({
    publicKey: tauriConfig.plugins.updater.pubkey,
    artifactPath,
    signature,
  });

  const expectedUrl = `https://github.com/chuspeeism/dashi-taskboard/releases/download/${releaseTag}/${path.basename(artifactPath)}`;
  const platform = latest.platforms?.[platformKey];
  if (platform?.url !== expectedUrl || platform.signature !== signature) {
    throw new Error(`latest.json ${platformKey} updater entry is incorrect`);
  }
}

console.log(`Verified Linux x86_64 deb and AppImage updaters for ${releaseTag}`);
