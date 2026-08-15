import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const injectionSource = await readFile(
  fileURLToPath(new URL("../inject/codex-taskboard.user.js", import.meta.url)),
  "utf8",
);

test("mounts Taskboard immediately after a nested Plugins action", async ({ page }) => {
  await page.setContent(`
    <html lang="zh-CN"><body>
      <div data-app-action-sidebar-scroll>
        <div><button><span>首页</span></button></div>
        <div><button><span>站点</span></button></div>
        <div class="sidebar-action-row">
          <button><svg></svg><span class="text-fade-truncate">插件</span></button>
        </div>
        <section data-app-action-sidebar-section>
          <div data-app-action-sidebar-section-heading="项目">项目</div>
        </section>
      </div>
    </body></html>
  `);
  await page.evaluate(() => {
    Object.assign(window, {
      __CODEX_TASKBOARD_SOURCE_HASH__: "nested-plugin-regression",
    });
  });
  await page.addScriptTag({ content: injectionSource });

  const plugin = page.getByRole("button", { name: "插件", exact: true });
  const entry = page.locator("#codex-taskboard-entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute("title", "任务面板");
  await expect(entry.evaluate((element) => element.previousElementSibling?.textContent?.trim())).resolves.toBe("插件");
  await expect(entry.evaluate((element) => element.parentElement)).resolves.toBeTruthy();
  await expect(plugin).toHaveCount(1);
});
