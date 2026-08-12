#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const releasePolicy = JSON.parse(readFileSync(
  path.join(projectRoot, "src-tauri", "release.json"),
  "utf8",
));

if (!appPath) throw new Error("Usage: sign-macos-app.mjs <App.app>");
if (!identity) throw new Error("APPLE_SIGNING_IDENTITY is required");

const nodePath = path.join(appPath, "Contents", "MacOS", "node");
const launcherPath = path.join(appPath, "Contents", "MacOS", "codex-taskboard-launcher");
const entitlementsPath = path.join(projectRoot, "src-tauri", "Entitlements.plist");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function entitlements(targetPath) {
  const { stdout } = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", targetPath]);
  const { stdout: json } = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: stdout,
  });
  return JSON.parse(json);
}

function signingDetails(targetPath) {
  return run("/usr/bin/codesign", ["-dv", "--verbose=4", targetPath]).stderr;
}

run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", nodePath]);
const nodeDetails = signingDetails(nodePath);
if (!nodeDetails.includes(`TeamIdentifier=${releasePolicy.nodeTeamId}`)) {
  throw new Error("Bundled Node.js does not have the verified Node.js Foundation signature");
}
const nodeEntitlements = entitlements(nodePath);
for (const entitlement of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]) {
  if (nodeEntitlements[entitlement] !== true) {
    throw new Error(`Bundled Node.js is missing ${entitlement}`);
  }
}

run("/usr/bin/xattr", ["-crs", appPath]);
run("/usr/bin/codesign", [
  "--force",
  "--timestamp",
  "--options",
  "runtime",
  "--entitlements",
  entitlementsPath,
  "--sign",
  identity,
  launcherPath,
]);
run("/usr/bin/codesign", [
  "--force",
  "--timestamp",
  "--options",
  "runtime",
  "--entitlements",
  entitlementsPath,
  "--sign",
  identity,
  appPath,
]);

run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
if (Object.keys(entitlements(launcherPath)).length !== 0) {
  throw new Error("The launcher must use the empty App entitlement policy");
}
if (!signingDetails(nodePath).includes(`TeamIdentifier=${releasePolicy.nodeTeamId}`)) {
  throw new Error("Signing the App replaced the Node.js Foundation signature");
}
for (const targetPath of [launcherPath, appPath]) {
  if (!signingDetails(targetPath).includes(`TeamIdentifier=${releasePolicy.appleTeamId}`)) {
    throw new Error(`Signed target does not use Apple Team ${releasePolicy.appleTeamId}`);
  }
}
const signedNodeEntitlements = entitlements(nodePath);
for (const entitlement of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]) {
  if (signedNodeEntitlements[entitlement] !== true) {
    throw new Error(`Signed App Node.js is missing ${entitlement}`);
  }
}

run(nodePath, [
  "-e",
  "let total=0; const add=(value)=>value+1; for(let i=0;i<5000000;i+=1) total=add(total); if(total!==5000000) process.exit(1)",
]);

console.log(`Signed and verified ${appPath}`);
