import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const componentsUrl = new URL("../web/src/components/", import.meta.url);
const componentFiles = (await readdir(componentsUrl))
  .filter((name) => name.endsWith(".tsx") && name !== "LinearIcon.tsx")
  .map((name) => new URL(name, componentsUrl));
const productFiles = [new URL("../web/src/App.tsx", import.meta.url), ...componentFiles];
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const iconSource = await readFile(new URL("../web/src/components/LinearIcon.tsx", import.meta.url), "utf8");
const taskboardIconSource = await readFile(
  new URL("../web/src/components/TaskboardIcon.tsx", import.meta.url),
  "utf8",
);
const dashboardStyles = await readFile(
  new URL("../web/src/components/DashboardView.css", import.meta.url),
  "utf8",
);

test("product UI uses the reverse-engineered Linear icon system", async () => {
  for (const file of productFiles) {
    const source = await readFile(file, "utf8");
    const sourceWithoutDashboardChart = file.pathname.endsWith("/DashboardView.tsx")
      ? source.replace(/<svg\s+className="dashboard-progress-chart"[\s\S]*?<\/svg>/, "")
      : source;
    assert.doesNotMatch(
      sourceWithoutDashboardChart,
      /<svg\b/,
      `${file.pathname} contains a hand-drawn SVG outside the dashboard progress chart`,
    );
    assert.doesNotMatch(source, /[★✓☼☾⌕›▣↻]|•••|···/, `${file.pathname} contains a text glyph used as an icon`);
  }
});

test("legacy CSS-drawn status and priority icons stay removed", () => {
  assert.doesNotMatch(
    styles,
    /brand-mark i|context-status-glyph|context-priority-glyph|filter-priority-glyph|filter-unlinked-glyph/,
  );
});

test("new workflow statuses use the central Linear icon mapping and semantic colors", () => {
  assert.match(iconSource, /in_review: "statusStarted"/);
  assert.match(iconSource, /blocked: "alert"/);
  assert.match(iconSource, /canceled: "statusCanceled"/);
  assert.match(iconSource, /statusCanceled: \{[\s\S]*?M8 15A7 7 0 1 0 8 1/);
  assert.match(styles, /--status-review: #43bc58/);
  assert.match(styles, /--status-blocked: #f34e52/);
  assert.match(styles, /--status-canceled: #9e9ea1/);
  assert.match(styles, /\.status-icon-review \{ color: var\(--status-review\); \}/);
  assert.match(styles, /\.status-icon-blocked \{ color: var\(--status-blocked\); \}/);
  assert.match(styles, /\.status-icon-canceled \{ color: var\(--status-canceled\); \}/);
});

test("dark mode keeps monochrome image icons visible without changing colored icons", () => {
  assert.match(taskboardIconSource, /const MONOCHROME_ICONS = new Set<TaskboardIconName>/);
  assert.match(taskboardIconSource, /MONOCHROME_ICONS\.has\(name\) \? "taskboard-icon-monochrome"/);
  assert.match(styles, /\[data-theme="dark"\] \.taskboard-icon-monochrome,[\s\S]*?filter: invert\(1\)/);
  assert.match(styles, /\[data-theme="dark"\] \.detail-copy-action-icon img/);
  assert.match(styles, /\[data-theme="dark"\] \.gantt_tree_icon img/);
  assert.match(dashboardStyles, /\[data-theme="dark"\][^{]*\.dashboard-upcoming-row img \{\s*filter: invert\(1\)/);
});
