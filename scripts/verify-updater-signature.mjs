#!/usr/bin/env node

import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

function decodedEnvelope(value, label) {
  const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment: ")) {
    throw new Error(`${label} is not a Tauri minisign envelope`);
  }
  return decoded;
}

export async function verifyUpdaterSignature({ publicKey, artifactPath, signature }) {
  const publicLines = decodedEnvelope(publicKey, "Updater public key").trim().split("\n");
  const publicRecord = Buffer.from(publicLines[1] ?? "", "base64");
  if (publicRecord.length !== 42) throw new Error("Updater public key is invalid");

  const signatureLines = decodedEnvelope(signature, "Updater signature").trim().split("\n");
  const signatureRecord = Buffer.from(signatureLines[1] ?? "", "base64");
  const globalSignature = Buffer.from(signatureLines[3] ?? "", "base64");
  if (signatureRecord.length !== 74 || globalSignature.length !== 64) {
    throw new Error("Updater signature is invalid");
  }
  if (!signatureLines[2]?.startsWith("trusted comment: ")) {
    throw new Error("Updater signature trusted comment is invalid");
  }
  if (!publicRecord.subarray(2, 10).equals(signatureRecord.subarray(2, 10))) {
    throw new Error("Updater signature was created with a different key");
  }

  const algorithm = signatureRecord.subarray(0, 2).toString("ascii");
  if (algorithm !== "ED") throw new Error("Updater signature must use prehashed minisign");
  const artifact = await readFile(artifactPath);
  const digest = createHash("blake2b512").update(artifact).digest();
  const verificationKey = await webcrypto.subtle.importKey(
    "raw",
    publicRecord.subarray(10),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const fileSignature = signatureRecord.subarray(10);
  if (!await webcrypto.subtle.verify("Ed25519", verificationKey, fileSignature, digest)) {
    throw new Error("Updater archive signature verification failed");
  }

  const trustedComment = Buffer.from(signatureLines[2].slice("trusted comment: ".length));
  const globalMessage = Buffer.concat([fileSignature, trustedComment]);
  if (!await webcrypto.subtle.verify(
    "Ed25519",
    verificationKey,
    globalSignature,
    globalMessage,
  )) {
    throw new Error("Updater signature trusted comment verification failed");
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const publicKeyPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const artifactPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const signaturePath = process.argv[4] ? path.resolve(process.argv[4]) : null;
  if (!publicKeyPath || !artifactPath || !signaturePath) {
    throw new Error(
      "Usage: verify-updater-signature.mjs <public-key> <archive> <signature>",
    );
  }
  await verifyUpdaterSignature({
    publicKey: await readFile(publicKeyPath, "utf8"),
    artifactPath,
    signature: await readFile(signaturePath, "utf8"),
  });
  console.log(`Verified updater signature for ${artifactPath}`);
}
