const REFERENCE_FORMAT = "taskboard.composer-reference.v1";
const REFERENCE_PREFIX = "taskboard://composer-reference/v1";
const REFERENCE_KINDS = new Set(["skill", "agent"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function encodeComposerReferenceKey(stableId) {
  let binary = "";
  for (const byte of new TextEncoder().encode(requiredString(stableId, "stableId"))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeComposerReferenceKey(referenceKey) {
  const key = requiredString(referenceKey, "referenceKey");
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new TypeError("referenceKey must be unpadded base64url");
  }
  let decoded;
  try {
    const padded = `${key.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - key.length % 4) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError("referenceKey is not canonical base64url UTF-8");
  }
  if (!decoded || encodeComposerReferenceKey(decoded) !== key) {
    throw new TypeError("referenceKey is not canonical base64url UTF-8");
  }
  return decoded;
}

export function readComposerReferenceId(referenceKey, kind) {
  try {
    const stableId = decodeComposerReferenceKey(referenceKey);
    return kind === "skill" && stableId !== stableId.normalize("NFC") ? null : stableId;
  } catch {
    return null;
  }
}

function assertReferenceKind(kind) {
  if (!REFERENCE_KINDS.has(kind)) {
    throw new TypeError("kind must be 'skill' or 'agent'");
  }
  return kind;
}

function escapedMarkdownLabel(label) {
  return requiredString(label, "label").replace(/[\\[\]]/g, "\\$&");
}

export function composerReferenceUri(kind, stableId) {
  return `${REFERENCE_PREFIX}/${assertReferenceKind(kind)}/${encodeComposerReferenceKey(stableId)}`;
}

export function composerReferencePersistence(kind, stableId, label) {
  const normalizedStableId = kind === "skill"
    ? requiredString(stableId, "stableId").normalize("NFC")
    : requiredString(stableId, "stableId");
  const referenceKey = encodeComposerReferenceKey(normalizedStableId);
  const uri = `${REFERENCE_PREFIX}/${assertReferenceKind(kind)}/${referenceKey}`;
  return {
    format: REFERENCE_FORMAT,
    kind,
    referenceKey,
    markdown: `[${escapedMarkdownLabel(label)}](${uri})`,
  };
}

export function parseComposerReferenceUri(uri) {
  const value = requiredString(uri, "uri");
  const match = /^taskboard:\/\/composer-reference\/v1\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new TypeError("uri is not a composer reference v1 URI");
  const kind = assertReferenceKind(match[1]);
  const stableId = decodeComposerReferenceKey(match[2]);
  if (kind === "skill" && stableId !== stableId.normalize("NFC")) {
    throw new TypeError("skill reference identity must use NFC normalization");
  }
  return { format: REFERENCE_FORMAT, kind, referenceKey: match[2], stableId };
}

export const COMPOSER_REFERENCE_FORMAT = REFERENCE_FORMAT;
