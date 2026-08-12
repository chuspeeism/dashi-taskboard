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
if (!appPath) throw new Error("Usage: preflight-macos-app.mjs <App.app>");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasePolicy = JSON.parse(await readFile(
  path.join(projectRoot, "src-tauri", "release.json"),
  "utf8",
));
const entitlementsPath = path.join(projectRoot, "src-tauri", "Entitlements.plist");

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

function verifyNode(targetApp) {
  const nodePath = path.join(targetApp, "Contents", "MacOS", "node");
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", nodePath]);
  if (!signingDetails(nodePath).includes(`TeamIdentifier=${releasePolicy.nodeTeamId}`)) {
    throw new Error(`Node does not use Team ${releasePolicy.nodeTeamId}`);
  }
  const policy = entitlements(nodePath);
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]) {
    if (policy[entitlement] !== true) throw new Error(`Node is missing ${entitlement}`);
  }
  run(nodePath, [
    "-e",
    "let n=0; const add=(v)=>v+1; for(let i=0;i<5000000;i+=1)n=add(n); if(n!==5000000)process.exit(1)",
  ]);
}

async function manifest(root, relative = "") {
  const entries = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
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

verifyNode(appPath);
const launcherPath = path.join(appPath, "Contents", "MacOS", "codex-taskboard-launcher");
for (const targetPath of [launcherPath, appPath]) {
  run("/usr/bin/codesign", [
    "--force",
    "--options", "runtime",
    "--entitlements", entitlementsPath,
    "--sign", "-",
    targetPath,
  ]);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
verifyNode(appPath);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-preflight."));
let mountedDmg = null;
try {
  const archivePath = path.join(temporaryRoot, "Codex.Taskboard.preflight.app.tar.gz");
  run("/usr/bin/tar", ["-czf", archivePath, path.basename(appPath)], {
    cwd: path.dirname(appPath),
  });
  const keyPath = path.join(temporaryRoot, "updater.key");
  run(path.join(projectRoot, "node_modules", ".bin", "tauri"), [
    "signer", "generate", "--ci", "--password", "", "--write-keys", keyPath,
  ]);
  run(path.join(projectRoot, "node_modules", ".bin", "tauri"), [
    "signer", "sign", "--private-key-path", keyPath, "--password", "", archivePath,
  ]);
  await verifyUpdaterSignature({
    publicKey: await readFile(`${keyPath}.pub`, "utf8"),
    artifactPath: archivePath,
    signature: await readFile(`${archivePath}.sig`, "utf8"),
  });

  const extractedDirectory = path.join(temporaryRoot, "updater");
  run("/bin/mkdir", ["-p", extractedDirectory]);
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", extractedDirectory]);
  const extractedApp = path.join(extractedDirectory, path.basename(appPath));
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
  verifyNode(extractedApp);

  const dmgPath = path.join(temporaryRoot, "Codex.Taskboard.preflight.dmg");
  const dmgSource = path.join(temporaryRoot, "dmg-source");
  run("/bin/mkdir", ["-p", dmgSource]);
  run("/usr/bin/ditto", [appPath, path.join(dmgSource, path.basename(appPath))]);
  run("/usr/bin/hdiutil", [
    "create", "-quiet", "-fs", "HFS+", "-srcfolder", dmgSource, dmgPath,
  ]);
  run("/usr/bin/hdiutil", ["verify", dmgPath]);
  const attach = run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-plist", dmgPath]);
  const attachJson = JSON.parse(run(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { input: attach.stdout },
  ).stdout);
  mountedDmg = attachJson["system-entities"]
    .map((entry) => entry["mount-point"])
    .find(Boolean);
  if (!mountedDmg) throw new Error("Preflight DMG did not expose a mount point");
  const dmgApp = path.join(mountedDmg, path.basename(appPath));
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", dmgApp]);
  verifyNode(dmgApp);

  const expectedManifest = JSON.stringify(await manifest(appPath));
  if (JSON.stringify(await manifest(extractedApp)) !== expectedManifest) {
    throw new Error("Preflight updater App differs from the source App");
  }
  if (JSON.stringify(await manifest(dmgApp)) !== expectedManifest) {
    throw new Error("Preflight DMG App differs from the source App");
  }
} finally {
  if (mountedDmg) run("/usr/bin/hdiutil", ["detach", mountedDmg]);
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Verified secretless macOS App, updater, and DMG preflight");
