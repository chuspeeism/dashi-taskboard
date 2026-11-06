import { readFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { attachmentFixture, createIssue, createProject, openIssue, tasks } from './helpers';

test('comment create, edit, delete and issue attachment upload, download, delete', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E comments and files');
  await createIssue(screen, 'Discussion issue');
  await openIssue(screen, 'Discussion issue');
  await screen.getByRole('textbox', 'Leave a comment').fill('Initial comment');
  await screen.getByRole('button', 'Comment').tap();
  await expect(screen.getByText('Initial comment')).toBeVisible();
  await screen.getByRole('button', 'Comment actions').tap();
  await screen.getByRole('menuitem', 'Edit comment').tap();
  await screen.getByRole('textbox', 'Edit comment').fill('Updated comment');
  await screen.getByRole('button', 'Save').tap();
  await expect(screen.getByText('Updated comment')).toBeVisible();
  await browser.reload();
  await expect(screen.getByText('Updated comment')).toBeVisible();
  // Issue attachments live inline in the description: add the file in the
  // description composer, then leave the composer (the Activity heading is a
  // neutral blur target) so it saves and renders as an attachment card.
  await screen.getByRole('button', 'Edit issue description').tap();
  await browser.locator('.issue-description-composer input[type=file]').setInputFiles(attachmentFixture);
  // The chip's remove control is revealed on chip hover, like the relation rows.
  await browser.locator('.inline-media-attachment').filter({ hasText: 'attachment.txt' }).hover();
  await expect(screen.getByRole('button', 'Remove attachment.txt')).toBeVisible();
  await screen.getByRole('heading', 'Activity').tap();
  await expect(screen.getByRole('link', /attachment\.txt/)).toBeVisible();
  const downloaded = await browser.waitForDownload(() => screen.getByRole('link', /attachment\.txt/).tap());
  expect(await readFile(downloaded.absolutePath, 'utf8')).toBe('Dashi E2E attachment fixture\n');
  // The saved card fills the read view, so a tap would land on its link; open
  // the editor through the read view's own Enter shortcut instead.
  await screen.getByRole('button', 'Edit issue description').press('Enter');
  await browser.locator('.inline-media-attachment').filter({ hasText: 'attachment.txt' }).hover();
  await screen.getByRole('button', 'Remove attachment.txt').tap();
  await screen.getByRole('heading', 'Activity').tap();
  await expect(screen.getByRole('link', /attachment\.txt/)).toBeHidden();
  await screen.getByRole('button', 'Comment actions').tap();
  await screen.getByRole('menuitem', 'Delete comment').tap();
  await screen.getByRole('alertdialog').getByRole('button', 'Delete comment').tap();
  await expect(screen.getByText('Updated comment')).toBeHidden();
});

test('comment attachments are uploaded with the comment and removed through UI', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E comment files');
  await createIssue(screen, 'Comment attachment issue');
  await openIssue(screen, 'Comment attachment issue');
  await screen.getByRole('textbox', 'Leave a comment').fill('Comment with file');
  await browser.locator('.comment-composer input[type=file]').setInputFiles(attachmentFixture);
  // Pending files render as chips in the composer; the remove control is
  // revealed on chip hover, like the relation rows.
  await browser.locator('.inline-media-attachment').filter({ hasText: 'attachment.txt' }).hover();
  await expect(screen.getByRole('button', 'Remove attachment.txt')).toBeVisible();
  await screen.getByRole('button', 'Comment').tap();
  await expect(screen.getByRole('link', /attachment\.txt/)).toBeVisible();
  await browser.reload();
  await expect(screen.getByRole('link', /attachment\.txt/)).toBeVisible();
  await screen.getByRole('button', 'Comment actions').tap();
  await screen.getByRole('menuitem', 'Edit comment').tap();
  await browser.locator('.inline-media-attachment').filter({ hasText: 'attachment.txt' }).hover();
  await screen.getByRole('button', 'Remove attachment.txt').tap();
  await screen.getByRole('button', 'Save').tap();
  await expect(screen.getByRole('link', /attachment\.txt/)).toBeHidden();
  await expect(screen.getByText('Comment with file')).toBeVisible();
});

test('parent, sub-issue, blocked-by, blocks and related relations can be added and removed', async ({ app, screen, browser }) => {
  await app.open('/?lang=en');
  await createProject(screen, 'E2E relations');
  for (const title of ['Relation anchor', 'Relation target']) await createIssue(screen, title);
  await openIssue(screen, 'Relation anchor');
  const target = (await tasks(browser)).find(task => task.title === 'Relation target');
  expect(target).toBeDefined();
  for (const label of ['Set parent issue', 'Add sub-issue', 'Add blocker', 'Add blocked issue', 'Add related issue']) {
    await screen.getByRole('button', label).tap();
    await screen.getByPlaceholder('Search issues…').fill('Relation target');
    await screen.getByRole('option', new RegExp(target!.identifier)).tap();
    await expect(screen.getByRole('button', `Remove ${target!.identifier}`)).toBeVisible();
    await browser.reload();
    await expect(screen.getByRole('button', `Remove ${target!.identifier}`)).toBeVisible();
    // The remove control is revealed on row hover (opacity 0 until then), so
    // hover the row the way a pointing user would, then tap.
    const row = browser.locator('.issue-relation-row').filter({ hasText: target!.identifier });
    await row.hover();
    await screen.getByRole('button', `Remove ${target!.identifier}`).tap();
    await expect(screen.getByRole('button', `Remove ${target!.identifier}`)).toBeHidden();
  }
});
