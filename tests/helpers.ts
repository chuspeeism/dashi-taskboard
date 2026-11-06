import { fileURLToPath } from 'node:url';
import type { Browser } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';

export const attachmentFixture = fileURLToPath(new URL('./fixtures/attachment.txt', import.meta.url));

export async function createProject(screen: Screen, name: string) {
  // On first use the app opens the project menu by itself (FIRST_USE_COMPLETE_KEY
  // is unset), so only tap the switcher when the menu is not already visible.
  const menu = screen.getByRole('menu', 'Projects');
  if (!(await menu.isVisible())) {
    await screen.getByRole('button', 'Switch project').tap();
  }
  await expect(menu).toBeVisible();
  await screen.getByRole('menuitem', 'Create project').tap();
  await screen.getByLabel('Project name').fill(name);
  await screen.getByRole('button', 'Create').tap();
  await expect(screen.getByRole('button', 'Switch project')).toContainText(name);
}

export async function createIssue(screen: Screen, title: string) {
  await screen.getByRole('button', 'Create issue').tap();
  const dialog = screen.getByRole('dialog', 'New issue');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', 'Create issue').tap();
  await expect(dialog).toBeHidden();
}

export async function openIssue(screen: Screen, title: string) {
  await screen.getByRole('button', new RegExp(`^Open .*: ${title}$`)).tap();
  await expect(screen.getByLabel('Issue title')).toHaveValue(title);
}

export interface E2ETask {
  id: string;
  projectId: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
  recurrence: { interval: number; unit: string } | null;
}

export async function tasks(browser: Browser): Promise<E2ETask[]> {
  return browser.evaluate(async () => {
    const response = await fetch('/api/tasks');
    if (!response.ok) throw new Error(`tasks returned ${response.status}`);
    const payload = await response.json() as { tasks: E2ETask[] };
    return payload.tasks;
  });
}

export async function pick(screen: Screen, property: string, value: string) {
  await screen.getByRole('button', property).tap();
  await screen.getByRole('option', value).tap();
  await expect(screen.getByRole('button', property)).toContainText(value);
}
