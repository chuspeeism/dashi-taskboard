import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createIssue, createProject, openIssue, pick, tasks } from './helpers';

test('issue creation, inline editing, properties, recurrence and persisted reload', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E issue properties');
  await createIssue(screen, 'UI created issue');
  await openIssue(screen, 'UI created issue');
  await screen.getByLabel('Issue title').fill('UI edited issue');
  await screen.getByLabel('Issue title').press('Tab');
  await screen.getByRole('button', 'Edit issue description').tap();
  await screen.getByRole('textbox', 'Issue description').fill('Description saved through the UI');
  await screen.getByRole('button', 'Status').tap();
  await screen.getByRole('option', 'In progress').tap();
  await pick(screen, 'Priority', 'High');
  await screen.getByRole('button', 'Assignee').tap();
  await screen.getByRole('option', /\(me\)/).tap();
  await screen.getByRole('button', 'Select or create labels').tap();
  await screen.getByLabel('Search labels').fill('e2e-label');
  await screen.getByRole('button', 'Create “e2e-label”').tap();
  await screen.getByLabel('Search labels').press('Escape');
  await screen.getByLabel('Start date').fill('2026-10-06');
  await screen.getByLabel('Due date').fill('2026-10-07');
  // Recurrence is a property picker like Status/Priority, not a native select.
  await pick(screen, 'Recurrence', 'Daily');
  await expect.poll(async () => (await tasks(browser)).find(task => task.title === 'UI edited issue')).toMatchObject({
    description: 'Description saved through the UI', status: 'in_progress', priority: 'high',
    labels: ['e2e-label'], startDate: '2026-10-06', dueDate: '2026-10-07', recurrence: { interval: 1, unit: 'day' },
  });
  await browser.reload();
  await expect(screen.getByLabel('Issue title')).toHaveValue('UI edited issue');
  await expect(screen.getByRole('button', 'Status')).toContainText('In progress');
  await expect(screen.getByLabel('Due date')).toHaveValue('2026-10-07');
  await expect(screen.getByRole('button', 'Recurrence')).toContainText('Daily');
  await screen.getByLabel('Due date').fill('');
  // Clearing the due date also clears the recurrence.
  await expect(screen.getByRole('button', 'Recurrence')).toContainText('Does not repeat');
  await expect.poll(async () => (await tasks(browser)).find(task => task.title === 'UI edited issue')?.recurrence).toBeNull();
});

test('context edit, duplicate, complete, archive, restore and permanent delete', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E issue lifecycle');
  await createIssue(screen, 'Lifecycle issue');
  const card = screen.getByRole('article', 'Lifecycle issue');
  await card.secondaryTap();
  // "Edit issue" in the context menu opens the issue detail view.
  await screen.getByRole('menuitem', /Edit issue/).tap();
  await screen.getByLabel('Issue title').fill('Lifecycle edited');
  await screen.getByLabel('Issue title').press('Tab');
  await screen.getByRole('button', 'Back to issue board').tap();
  await expect(screen.getByRole('article', 'Lifecycle edited')).toBeVisible();
  await screen.getByRole('article', 'Lifecycle edited').secondaryTap();
  await screen.getByRole('menuitem', /Create copy/).tap();
  await expect.poll(async () => (await tasks(browser)).filter(task => task.title.startsWith('Lifecycle edited')).length).toBe(2);
  const original = (await tasks(browser)).find(task => task.title === 'Lifecycle edited');
  expect(original).toBeDefined();
  // The card's Complete control only renders for in_review issues and is
  // revealed on card hover, so drive the issue to In review first.
  const originalCard = browser.locator(`[data-task-id="${original!.id}"]`);
  await originalCard.getByRole('button', new RegExp(`^Open ${original!.identifier}: `)).tap();
  await screen.getByRole('button', 'Status').tap();
  await screen.getByRole('option', 'In review').tap();
  await expect.poll(async () => (await tasks(browser)).find(task => task.id === original!.id)?.status).toBe('in_review');
  await screen.getByRole('button', 'Back to issue board').tap();
  await originalCard.hover();
  await screen.getByRole('button', `Complete ${original!.identifier}`).tap();
  await expect.poll(async () => (await tasks(browser)).find(task => task.id === original!.id)?.status).toBe('done');
  // Completed issues leave the board and live in the Other issues panel.
  await expect(originalCard).toBeHidden();
  // Archive / restore / permanently delete the remaining copy.
  const duplicate = (await tasks(browser)).find(task => task.id !== original!.id && task.title === 'Lifecycle edited');
  expect(duplicate).toBeDefined();
  const duplicateCard = browser.locator(`[data-task-id="${duplicate!.id}"]`);
  const panel = screen.getByRole('complementary', 'Other issues');
  await duplicateCard.secondaryTap();
  await screen.getByRole('menuitem', /Archive issue/).tap();
  await expect(duplicateCard).toBeHidden();
  await screen.getByRole('button', 'Open other issues').tap();
  await screen.getByRole('tab', /Archived/).tap();
  await expect(panel.getByText('Lifecycle edited')).toBeVisible();
  await panel.getByRole('button', 'Restore').tap();
  await expect(duplicateCard).toBeVisible();
  await screen.getByRole('button', 'Close other issues').tap();
  await duplicateCard.secondaryTap();
  await screen.getByRole('menuitem', /Archive issue/).tap();
  await screen.getByRole('button', 'Open other issues').tap();
  await screen.getByRole('tab', /Archived/).tap();
  await panel.getByRole('button', `Permanently delete ${duplicate!.identifier}`).tap();
  await screen.getByRole('button', 'Delete permanently').tap();
  await expect(panel.getByRole('button', `Permanently delete ${duplicate!.identifier}`)).toBeHidden();
  await expect.poll(async () => (await tasks(browser)).find(task => task.id === duplicate!.id)).toBeUndefined();
});
