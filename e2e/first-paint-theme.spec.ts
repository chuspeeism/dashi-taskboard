import { expect, test, type Page } from "@playwright/test";

async function blockMainBundle(page: Page) {
  await page.route(/\/assets\/index-[^/]+\.js(?:\?.*)?$/, (route) => route.abort());
}

test("standalone dark query is applied before the main bundle", async ({ page }) => {
  await blockMainBundle(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?theme=dark", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("#root")).toBeEmpty();
});

test("standalone system dark is applied before the main bundle", async ({ page }) => {
  await blockMainBundle(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("#root")).toBeEmpty();
});

test("embedded first paint ignores a standalone theme query", async ({ page }) => {
  await blockMainBundle(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?host=codex&theme=dark", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-embedded", "true");
  await expect(page.locator("#root")).toBeEmpty();
});
