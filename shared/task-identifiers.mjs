export const TASK_PREFIX_MIN_LENGTH = 2;
export const TASK_PREFIX_MAX_LENGTH = 6;

const KNOWN_PROJECT_PREFIXES = new Map([
  ["local-91a4a013fbe224e28872fc421391aab2", "VF"],
  ["ai-virtualfitting", "VF"],
  ["dashi-taskboard", "DT"],
  ["workflow-bridge", "WB"],
  ["local-1add370f38a64dde8725b3fc9ca87b47", "WB2"],
  ["26bb1f02-ee66-4a7a-912f-4e5512b6ddfb", "KOS"],
  ["knowledge-os", "KOS"],
  ["685d0e85-5e48-4442-980f-446ee213f731", "VAULT"],
  ["obsidian-vault", "VAULT"],
  ["4c3a4852-c8af-407d-8b36-8ace35fb1ab3", "WMP"],
  ["wechat-mini-programs", "WMP"],
  ["idea-inbox", "IDEA"],
  ["inbox-unclassified", "INBOX"],
  ["dashi-e2e-20260804", "E2E"],
  ["novel", "NOVEL"],
  ["592cbf4a-f123-4bce-be0e-15c9945f5529", "NOV2"],
  ["2b8c9610-546f-4f4e-be44-9cfdfb59ee6d", "QR"],
  ["60e40f4e-a8dd-4da4-b54c-defcbabdd84d", "FB"],
  ["local", "LOCAL"],
]);

export function normalizeTaskPrefix(value) {
  if (typeof value !== "string") return null;
  const prefix = value.trim().toUpperCase();
  const pattern = new RegExp(`^[A-Z][A-Z0-9]{${TASK_PREFIX_MIN_LENGTH - 1},${TASK_PREFIX_MAX_LENGTH - 1}}$`);
  return pattern.test(prefix) ? prefix : null;
}

function compactWords(value) {
  const words = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return words.map((word) => word[0]).join("").slice(0, TASK_PREFIX_MAX_LENGTH).toUpperCase();
  }
  return (words[0] ?? "").slice(0, TASK_PREFIX_MAX_LENGTH).toUpperCase();
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).toUpperCase().padStart(4, "0").slice(0, 4);
}

export function deriveTaskPrefix({ id, name }) {
  const known = KNOWN_PROJECT_PREFIXES.get(String(id).toLowerCase())
    ?? KNOWN_PROJECT_PREFIXES.get(String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  if (known) return known;
  const readable = compactWords(name) || compactWords(id);
  if (normalizeTaskPrefix(readable)) return readable;
  return `P${shortHash(`${id}:${name}`)}`;
}

export function uniqueTaskPrefix(preferred, reserved) {
  const normalized = normalizeTaskPrefix(preferred);
  if (!normalized) throw new TypeError("Task prefix must contain 2-6 uppercase letters or numbers and start with a letter");
  if (!reserved.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${normalized.slice(0, TASK_PREFIX_MAX_LENGTH - suffixText.length)}${suffixText}`;
    if (!reserved.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a unique task prefix for '${normalized}'`);
}

export function identifierNumber(identifier) {
  const match = /-(\d+)$/.exec(identifier);
  return match ? Number(match[1]) : null;
}
