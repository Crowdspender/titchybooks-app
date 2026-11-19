import { expect, test, type Page } from '@playwright/test';

const url = '/tests/browser-fixtures/design.html';
const pointerKey = 'titchybook-active-editor-draft';
const recoveryKey = (id: string) => `titchybook-recovery:fixture-user:${id}`;
const pointer = (page: Page) => page.evaluate(key => localStorage.getItem(key), pointerKey);
const creates = (page: Page) => page.evaluate(() => window.designFixture.createCount);
const separateDraft = (page: Page) => page.getByRole('button', { name: 'Create a separate draft', exact: true });

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3200' ? route.continue() : route.abort());
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => { throw error; });
});

test('a canceled boot\'s late draft creation does not overwrite the newer pointer', async ({ page }) => {
  await page.goto(url + '?bootCase&createDelay=1500');
  await expect(page.getByText('Creating your draft...', { exact: true })).toBeVisible();
  // Navigate to an explicit draft while the create POST is still in flight.
  await page.evaluate(() => window.designFixture.setSubmissionId('fixture'));
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('The Lantern and the Sea');
  expect(await pointer(page)).toBe('fixture');
  // Let the canceled boot's POST settle; it must not steal the pointer back.
  await page.waitForTimeout(2000);
  expect(await creates(page)).toBe(1);
  expect(await pointer(page)).toBe('fixture');
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('The Lantern and the Sea');
});

test('an explicit submission URL outranks a lingering separate-draft request', async ({ page }) => {
  await page.goto(url + '?bootCase&failLoad');
  await expect(separateDraft(page)).toBeVisible();
  await separateDraft(page).click();
  await expect(separateDraft(page)).toBeVisible();
  expect(await creates(page)).toBe(2);
  // Same mounted instance now receives an explicit submissionId: it must load
  // that draft instead of honoring the earlier separate-draft request.
  await page.evaluate(() => window.designFixture.setSubmissionId('fixture'));
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('The Lantern and the Sea');
  expect(await creates(page)).toBe(2);
  expect(await pointer(page)).toBe('fixture');
});

test('separate-draft clicks create fresh drafts while retry reuses the issued one', async ({ page }) => {
  await page.goto(url + '?bootCase&failLoad');
  await expect(separateDraft(page)).toBeVisible();
  await separateDraft(page).click();
  await expect(separateDraft(page)).toBeVisible();
  await separateDraft(page).click();
  await expect(separateDraft(page)).toBeVisible();
  expect(await creates(page)).toBe(3);
  expect(await pointer(page)).toBe('created-3');
  await page.evaluate(() => { window.designFixture.failLoad = false; });
  await page.getByRole('button', { name: 'Retry loading draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  // Retry keeps the issued draft: no replacement POST, same pointer.
  expect(await creates(page)).toBe(3);
  expect(await pointer(page)).toBe('created-3');
});

test('uncommitted inline text stays out of server saves until the session commits', async ({ page }) => {
  await page.goto(url + '?bootCase');
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  const box = (await page.locator('.konvajs-content').boundingBox())!;
  // The default text box starts at scene (72, 88) on a 700x1000 page; aim at
  // the first line's glyphs because Konva hit-testing is pixel-based.
  const point = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.105 };
  const inline = page.getByRole('textbox', { name: 'Edit text on page' });
  await page.mouse.dblclick(point.x, point.y);
  await expect(inline).toBeVisible();
  await inline.fill('Uncommitted inline text');
  // Recovery keeps the live overlay...
  const recovery = await page.evaluate(key => localStorage.getItem(key), recoveryKey('created-1'));
  expect(JSON.parse(recovery!).parts.FRONT_COVER.value).toContain('Uncommitted inline text');
  // ...but a reconnect flushAll must not write it to the server. (The added
  // text box itself autosaves with its original text; that write is fine.)
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1200);
  const saves = await page.evaluate(() => window.designFixture.saves);
  expect(saves.some(save => save.value.includes('Uncommitted inline text'))).toBe(false);
  // Escape discards the overlay without any server write.
  await inline.press('Escape');
  await expect(inline).toHaveCount(0);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), recoveryKey('created-1'))).toBeNull();
  expect((await page.evaluate(() => window.designFixture.saves)).some(save => save.value.includes('Uncommitted inline text'))).toBe(false);
  // A committed session does reach the server.
  await page.mouse.dblclick(point.x, point.y);
  await expect(inline).toBeVisible();
  await inline.fill('Committed inline text');
  await inline.press('Control+Enter');
  await expect(inline).toHaveCount(0);
  await expect.poll(async () =>
    (await page.evaluate(() => window.designFixture.saves))
      .some(save => save.part === 'FRONT_COVER' && save.value.includes('Committed inline text'))
  ).toBe(true);
});

test('a conflicted save offers an escape from the leave guard with recovery intact', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.evaluate(() => { window.designFixture.book.revision++; });
  await page.getByRole('textbox', { name: 'Book title' }).fill('Conflicted local title');
  await expect(page.getByRole('status').filter({ hasText: 'Save conflict' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), recoveryKey('fixture'))).not.toBeNull();
  // The sign-out style leave event must not trap the user behind the 409:
  // the dialog is auto-accepted, so the guard offers the escape and proceeds.
  const proceeded = await page.evaluate(() => new Promise<boolean>(resolve => {
    window.dispatchEvent(new CustomEvent('titchybook-before-leave', { detail: { proceed: () => resolve(true) } }));
    setTimeout(() => resolve(false), 5000);
  }));
  expect(proceeded).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), recoveryKey('fixture'))).not.toBeNull();
  expect(await page.evaluate(() => window.designFixture.book.title)).toBe('The Lantern and the Sea');
});

test('the reviewed recovery copy hides once the draft moves past it', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.evaluate(() => { window.designFixture.book.revision++; });
  await page.getByRole('textbox', { name: 'Book title' }).fill('First conflicted title');
  await expect(page.getByRole('status').filter({ hasText: 'Save conflict' })).toBeVisible();
  await page.getByRole('button', { name: 'Review recovery copy', exact: true }).click();
  const view = page.getByRole('textbox', { name: 'Local recovery JSON' });
  await expect(view).toBeVisible();
  expect(JSON.parse(await view.inputValue()).parts.title.value).toBe('First conflicted title');
  // Editing past the reviewed snapshot hides the stale copy...
  await page.getByRole('textbox', { name: 'Book title' }).fill('Second conflicted title');
  await expect(view).toHaveCount(0);
  // ...and a fresh review shows the newest local state.
  await page.getByRole('button', { name: 'Review recovery copy', exact: true }).click();
  await expect(view).toBeVisible();
  expect(JSON.parse(await view.inputValue()).parts.title.value).toBe('Second conflicted title');
});