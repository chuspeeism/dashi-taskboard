import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createIssue, createProject, openIssue, pick, tasks } from './helpers';

test('project create, switch, delete empty project and reject deleting a populated project', async ({ app, screen }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E project populated');
  await createIssue(screen, 'Project ownership issue');
  await createProject(screen, 'E2E project empty');
  await screen.getByRole('button', 'Switch project').tap();
  await screen.getByRole('menuitemradio', 'E2E project populated').tap();
  await expect(screen.getByRole('article', 'Project ownership issue')).toBeVisible();
  await screen.getByRole('button', 'Switch project').tap();
  await screen.getByRole('menuitemradio', 'E2E project populated').secondaryTap();
  await screen.getByRole('menuitem', 'Delete project').tap();
  // The dialog opens as a confirm; only after the server rejects the delete
  // (PROJECT_NOT_EMPTY) does it turn into the "Cannot delete" variant.
  await screen.getByRole('alertdialog').getByRole('button', 'Delete project').tap();
  await expect(screen.getByRole('button', 'Got it')).toBeVisible();
  await screen.getByRole('button', 'Got it').tap();
  await screen.getByRole('button', 'Switch project').tap();
  await screen.getByRole('menuitemradio', 'E2E project empty').secondaryTap();
  await screen.getByRole('menuitem', 'Delete project').tap();
  await screen.getByRole('button', 'Delete project').tap();
  await screen.getByRole('button', 'Switch project').tap();
  await expect(screen.getByRole('menuitemradio', 'E2E project empty')).toBeHidden();
  await expect(screen.getByRole('menuitemradio', 'E2E project populated')).toBeVisible();
});

test('search, status/priority/label filters and dashboard, board, list, gantt views', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E views and filters');
  await createIssue(screen, 'Search alpha');
  await createIssue(screen, 'Search beta');
  await openIssue(screen, 'Search alpha');
  await pick(screen, 'Priority', 'High');
  await pick(screen, 'Status', 'In progress');
  await screen.getByRole('button', 'Select or create labels').tap();
  await screen.getByLabel('Search labels').fill('view-label');
  await screen.getByRole('button', 'Create “view-label”').tap();
  await screen.getByLabel('Search labels').press('Escape');
  await screen.getByLabel('Start date').fill('2026-10-06');
  await screen.getByLabel('Due date').fill('2026-10-08');
  await screen.getByRole('button', 'Back to issue board').tap();
  await screen.getByRole('searchbox', 'Search issues').fill('alpha');
  await expect(screen.getByRole('article', 'Search alpha')).toBeVisible();
  await expect(screen.getByRole('article', 'Search beta')).toBeHidden();
  await screen.getByRole('button', 'Clear search').tap();
  for (const filter of ['In progress', 'High', 'view-label']) {
    await screen.getByRole('button', 'Filter issues').tap();
    await screen.getByRole('textbox', /^Add filter/).fill(filter);
    await screen.getByRole('menuitemcheckbox', new RegExp(`^${filter}`)).tap();
    await browser.keyboard.press('Escape');
    await expect(screen.getByRole('article', 'Search alpha')).toBeVisible();
    await expect(screen.getByRole('article', 'Search beta')).toBeHidden();
    await screen.getByRole('button', /^Filter issues/).tap();
    await screen.getByRole('button', /^Clear all filters/).tap();
    // Clearing unmounts the clear button and drops focus, so Escape no longer
    // reaches the menu; the menu is still open, so close it via the trigger.
    await screen.getByRole('button', /^Filter issues/).tap();
  }
  await screen.getByRole('button', 'Dashboard').tap();
  await expect(browser.locator('.dashboard-view')).toBeVisible();
  await screen.getByRole('button', 'List').tap();
  await expect(screen.getByText('Search alpha')).toBeVisible();
  await expect(screen.getByText('Search beta')).toBeVisible();
  await screen.getByRole('button', 'Gantt').tap();
  await expect(browser.locator('.gantt-view')).toBeVisible();
  await expect(screen.getByText('Search alpha').first()).toBeVisible();
  await screen.getByRole('button', 'Issue board').tap();
  await expect(screen.getByRole('article', 'Search alpha')).toBeVisible();
  expect((await tasks(browser)).filter(task => task.title.startsWith('Search '))).toHaveLength(2);
});

test('theme follows system color scheme, language route and mobile viewport remain usable', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  // The manual theme toggle is gone: the board follows prefers-color-scheme
  // and re-syncs live when the emulated system scheme changes.
  await browser.emulateMedia({ colorScheme: 'light' });
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'light');
  await browser.emulateMedia({ colorScheme: 'dark' });
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'dark');
  await browser.goto('/?lang=en');
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'dark');
  await browser.goto('/?lang=zh');
  await expect(screen.getByRole('button', '新建议题')).toBeVisible();
  await browser.setViewport({ width: 390, height: 844 });
  await screen.getByRole('button', '新建议题').tap();
  await screen.getByLabel('标题').fill('移动端议题');
  await screen.getByRole('dialog', '新建议题').getByRole('button', '创建议题').tap();
  await expect(screen.getByRole('dialog', '新建议题')).toBeHidden();
  await expect(screen.getByRole('article', '移动端议题')).toBeVisible();
});
