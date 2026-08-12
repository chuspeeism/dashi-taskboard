#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyUpdaterSignature } from "./verify-updater-signature.mjs";

const appPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const dmgPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const releaseDirectory = process.argv[4] ? path.resolve(process.argv[4]) : null;
const releaseTag = process.argv[5]?.trim();
if (!appPath || !dmgPath || !releaseDirectory || !releaseTag) {
  throw new Error(
    "Usage: verify-macos-release.mjs <App.app> <DMG.dmg> <release-directory> <release-tag>",
  );
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "tauri.conf.json"),
  "utf8",
));
const releasePolicy = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "release.json"),
  "utf8",
));
if (releaseTag !== `v${packageJson.version}`) {
  throw new Error("Release tag does not match package.json version");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function signingDetails(targetPath) {
  return run("/usr/bin/codesign", ["-dv", "--verbose=4", targetPath]).stderr;
}

function entitlements(targetPath) {
  const { stdout } = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", targetPath]);
  const { stdout: json } = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: stdout,
  });
  return JSON.parse(json);
}

function plistValue(targetPath, key) {
  return run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, targetPath]).stdout;
}

function verifyApp(targetPath) {
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", targetPath]);
  run("/usr/bin/xcrun", ["stapler", "validate", targetPath]);
  run("/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", targetPath]);
  const infoPath = path.join(targetPath, "Contents", "Info.plist");
  if (plistValue(infoPath, "CFBundleIdentifier") !== tauriConfig.identifier) {
    throw new Error("Updater App bundle identifier does not match tauri.conf.json");
  }
  if (plistValue(infoPath, "CFBundleShortVersionString") !== packageJson.version) {
    throw new Error("Updater App version does not match package.json");
  }
  if (!signingDetails(targetPath).includes(`TeamIdentifier=${releasePolicy.appleTeamId}`)) {
    throw new Error(`App does not use Apple Team ${releasePolicy.appleTeamId}`);
  }
  const launcherPath = path.join(targetPath, "Contents", "MacOS", "codex-taskboard-launcher");
  if (!signingDetails(launcherPath).includes(`TeamIdentifier=${releasePolicy.appleTeamId}`)) {
    throw new Error(`Launcher does not use Apple Team ${releasePolicy.appleTeamId}`);
  }
  const nodePath = path.join(targetPath, "Contents", "MacOS", "node");
  if (!signingDetails(nodePath).includes(`TeamIdentifier=${releasePolicy.nodeTeamId}`)) {
    throw new Error(`Node does not use Team ${releasePolicy.nodeTeamId}`);
  }
  const nodeEntitlements = entitlements(nodePath);
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]) {
    if (nodeEntitlements[entitlement] !== true) {
      throw new Error(`Node is missing ${entitlement}`);
    }
  }
}

async function manifest(root, relative = "") {
  const currentPath = path.join(root, relative);
  const entries = [];
  for (const name of (await readdir(currentPath)).sort()) {
    const childRelative = path.join(relative, name);
    const childPath = path.join(root, childRelative);
    const details = await lstat(childPath);
    if (details.isDirectory()) {
      entries.push({ path: childRelative, type: "directory", mode: details.mode & 0o777 });
      entries.push(...await manifest(root, childRelative));
    } else if (details.isSymbolicLink()) {
      entries.push({ path: childRelative, type: "symlink", target: await readlink(childPath) });
    } else if (details.isFile()) {
      entries.push({
        path: childRelative,
        type: "file",
        mode: details.mode & 0o777,
        size: details.size,
        sha256: createHash("sha256").update(await readFile(childPath)).digest("hex"),
      });
    }
  }
  return entries;
}

const artifactName = `Codex.Taskboard_${packageJson.version}_universal.app.tar.gz`;
const artifactPath = path.join(releaseDirectory, artifactName);
const signaturePath = `${artifactPath}.sig`;
const signature = await readFile(signaturePath, "utf8");
await verifyUpdaterSignature({
  publicKey: tauriConfig.plugins.updater.pubkey,
  artifactPath,
  signature,
});

const latest = JSON.parse(await readFile(path.join(releaseDirectory, "latest.json"), "utf8"));
if (latest.version !== packageJson.version) throw new Error("latest.json version is incorrect");
const expectedUrl = `https://github.com/chuspeeism/dashi-taskboard/releases/download/${releaseTag}/${artifactName}`;
const expectedPlatforms = [
  "darwin-aarch64",
  "darwin-x86_64",
  "darwin-universal",
  "darwin-aarch64-app",
  "darwin-x86_64-app",
  "darwin-universal-app",
];
if (JSON.stringify(Object.keys(latest.platforms).sort()) !== JSON.stringify(expectedPlatforms.sort())) {
  throw new Error("latest.json Darwin platform set is incorrect");
}
for (const platform of Object.values(latest.platforms)) {
  if (platform.url !== expectedUrl || platform.signature !== signature) {
    throw new Error("latest.json does not point every Darwin platform to the verified archive");
  }
}

verifyApp(appPath);
run("/usr/bin/hdiutil", ["verify", dmgPath]);
run("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
run("/usr/sbin/spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmgPath]);
if (!signingDetails(dmgPath).includes(`TeamIdentifier=${releasePolicy.appleTeamId}`)) {
  throw new Error(`DMG does not use Apple Team ${releasePolicy.appleTeamId}`);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-release-verify."));
let mountedDmg = null;
try {
  const updaterDirectory = path.join(temporaryRoot, "updater");
  run("/bin/mkdir", ["-p", updaterDirectory]);
  run("/usr/bin/tar", ["-xzf", artifactPath, "-C", updaterDirectory]);
  const updaterApp = path.join(updaterDirectory, path.basename(appPath));
  verifyApp(updaterApp);

  const attach = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmgPath]);
  const attachJson = JSON.parse(run(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { input: attach.stdout },
  ).stdout);
  mountedDmg = attachJson["system-entities"]
    .map((entry) => entry["mount-point"])
    .find(Boolean);
  if (!mountedDmg) throw new Error("DMG did not expose a mount point");
  const dmgApp = path.join(mountedDmg, path.basename(appPath));
  verifyApp(dmgApp);

  const [sourceManifest, updaterManifest, dmgManifest] = await Promise.all([
    manifest(appPath),
    manifest(updaterApp),
    manifest(dmgApp),
  ]);
  const expectedManifest = JSON.stringify(sourceManifest);
  if (JSON.stringify(updaterManifest) !== expectedManifest) {
    throw new Error("Updater archive App differs from the notarized source App");
  }
  if (JSON.stringify(dmgManifest) !== expectedManifest) {
    throw new Error("DMG App differs from the notarized source App");
  }

  run(path.join(updaterApp, "Contents", "MacOS", "node"), [
    "-e",
    "let n=0; const add=(v)=>v+1; for(let i=0;i<5000000;i+=1)n=add(n); if(n!==5000000)process.exit(1)",
  ]);
} finally {
  if (mountedDmg) run("/usr/bin/hdiutil", ["detach", mountedDmg]);
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`Verified signed macOS release ${releaseTag}`);
