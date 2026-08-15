import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function ruleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

function customProperty(source, name, selector = ":root") {
  const root = ruleBody(source, selector);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = root.match(new RegExp(`${escaped}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `Missing literal ${name} light-theme token`);
  return match[1];
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => channel(Number.parseInt(value, 16)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("light secondary text and focus roles meet their contrast contracts", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const surface = customProperty(styles, "--content-surface");
  const textTokens = ["--text-tertiary", "--text-quaternary", "--accent-text"];

  for (const token of textTokens) {
    const value = customProperty(styles, token);
    assert.ok(
      contrast(value, surface) >= 4.5,
      `${token} (${value}) must reach 4.5:1 against ${surface}`,
    );
  }

  const focus = customProperty(styles, "--focus-ring");
  assert.ok(
    contrast(focus, surface) >= 3,
    `--focus-ring (${focus}) must reach 3:1 against ${surface}`,
  );

  const darkFocus = customProperty(styles, "--focus-ring", ':root[data-theme="dark"]');
  const darkSurface = customProperty(styles, "--content-surface", ':root[data-theme="dark"]');
  assert.ok(
    contrast(darkFocus, darkSurface) >= 3,
    `dark --focus-ring (${darkFocus}) must reach 3:1 against ${darkSurface}`,
  );
});

test("small tertiary roles remain readable on the real light and dark content surfaces", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const combinations = [
    {
      label: "light quaternary on muted surface",
      foreground: customProperty(styles, "--text-quaternary"),
      background: customProperty(styles, "--surface-muted"),
    },
    ...["--text-tertiary", "--text-quaternary"].flatMap((token) => (
      ["--content-surface", "--surface-muted"].map((surface) => ({
        label: `dark ${token} on ${surface}`,
        foreground: customProperty(styles, token, ':root[data-theme="dark"]'),
        background: customProperty(styles, surface, ':root[data-theme="dark"]'),
      }))
    )),
  ];

  for (const { label, foreground, background } of combinations) {
    const ratio = contrast(foreground, background);
    assert.ok(
      ratio >= 4.5,
      `${label} must reach 4.5:1; received ${ratio.toFixed(2)}:1 (${foreground} on ${background})`,
    );
  }
});

test("relation warning and danger text remain readable on detail surfaces", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const combinations = [
    ...["--relation-warning-text", "--relation-danger-text"].map((token) => ({
      label: `light ${token}`,
      foreground: customProperty(styles, token),
      background: customProperty(styles, "--content-surface"),
    })),
    ...["--relation-warning-text", "--relation-danger-text"].map((token) => ({
      label: `dark ${token}`,
      foreground: customProperty(styles, token, ':root[data-theme="dark"]'),
      background: customProperty(styles, "--content-surface", ':root[data-theme="dark"]'),
    })),
  ];

  for (const { label, foreground, background } of combinations) {
    const ratio = contrast(foreground, background);
    assert.ok(
      ratio >= 4.5,
      `${label} must reach 4.5:1; received ${ratio.toFixed(2)}:1 (${foreground} on ${background})`,
    );
  }
});

test("automation menu text tokens remain readable while controls are unavailable", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const combinations = [
    ...["--text-primary", "--text-secondary", "--text-tertiary"].map((token) => ({
      label: `light ${token} on automation surface`,
      foreground: customProperty(styles, token),
      background: customProperty(styles, "--bg"),
    })),
    ...["--text-primary", "--text-secondary", "--text-tertiary"].map((token) => ({
      label: `dark ${token} on automation surface`,
      foreground: customProperty(styles, token, ':root[data-theme="dark"]'),
      background: customProperty(styles, "--bg", ':root[data-theme="dark"]'),
    })),
  ];

  for (const { label, foreground, background } of combinations) {
    const ratio = contrast(foreground, background);
    assert.ok(
      ratio >= 4.5,
      `${label} must reach 4.5:1; received ${ratio.toFixed(2)}:1 (${foreground} on ${background})`,
    );
  }
});

test("primary action fills keep white compact button text readable in both themes", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const combinations = [
    ...["--action-fill", "--action-fill-hover"].map((token) => ({
      label: `light ${token}`,
      background: customProperty(styles, token),
    })),
    ...["--action-fill", "--action-fill-hover"].map((token) => ({
      label: `dark ${token}`,
      background: customProperty(styles, token, ':root[data-theme="dark"]'),
    })),
  ];

  for (const { label, background } of combinations) {
    const ratio = contrast("#ffffff", background);
    assert.ok(
      ratio >= 4.5,
      `${label} must keep white text at 4.5:1; received ${ratio.toFixed(2)}:1 (#ffffff on ${background})`,
    );
  }

  assert.match(ruleBody(styles, ".button.primary"), /background:\s*var\(--action-fill\)/);
  assert.match(ruleBody(styles, ".button.primary:hover:not(:disabled)"), /background:\s*var\(--action-fill-hover\)/);
});

test("the lazy workflow overlay does not reintroduce unapproved backdrop blur", async () => {
  const workflowStyles = await readFile(new URL("../web/src/components/workflow.css", import.meta.url), "utf8");
  assert.doesNotMatch(
    ruleBody(workflowStyles, ".workflow-step-picker-backdrop"),
    /(?:-webkit-)?backdrop-filter\s*:/,
  );
});

test("light and dark drop targets have explicit opaque surfaces above legacy transparent rules", async () => {
  const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const light = ruleBody(styles, ':root:not([data-theme="dark"]) .board-column.is-drop-target');
  const dark = ruleBody(styles, ':root[data-theme="dark"] .board-column.is-drop-target');

  assert.match(light, /background:\s*#[0-9a-f]{6}\s*;/i);
  assert.match(dark, /background:\s*#[0-9a-f]{6}\s*;/i);
  assert.doesNotMatch(light, /box-shadow/);
  assert.doesNotMatch(dark, /box-shadow/);
});
