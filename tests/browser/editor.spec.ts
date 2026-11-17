import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { PAGE_LABEL_DISPLAY, PAGE_LABELS } from '@/lib/constants';
import { parseRenderSnapshot } from '@/lib/pdf/snapshot';

const password = 'Isolated-test-password-42!';
let userId: string;
async function openDraft(page: Page) {
  const draft = await createDraft(userId);
  await page.goto(`/create?submissionId=${draft.id}`);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  return draft.id;
}
async function addText(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  await page.getByRole('textbox', { name: 'Element text', exact: true }).fill(text);
}

test.beforeEach(async ({ page, context }) => {
  const user = await createUser('USER', await hash(password, 10));
  userId = user.id;
  // No storage, email, or AI provider requests are permitted from the browser.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
test.afterEach(async ({ page }) => {
  // Stop autosaves before cleaning only this test's owned fixtures.
  await page.close();
  await cleanupFixtures();
});
test.afterAll(async () => { await db.$disconnect(); });

test('saves all eight pages, reopens exact scenes, and submits with the worker paused', async ({ page }) => {
  const id = await openDraft(page);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Eight-page browser regression');
  for (const label of PAGE_LABELS) {
    const pageButton = page.getByRole('button', { name: `Edit ${PAGE_LABEL_DISPLAY[label]}`, exact: true });
    await pageButton.click();
    // Switching pages awaits the outgoing autosave before it commits, and a
    // switch click is ignored while one is already in flight. Wait for
    // aria-current so the elements below cannot land on the page being left,
    // which is what happens when the database is slow enough to widen the gap.
    await expect(pageButton).toHaveAttribute('aria-current', 'page');
    await addText(page, `Unique text ${label}`);
    await page.getByRole('button', { name: 'Add Shape' }).hover();
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const before = await db.submissionPage.findMany({ where: { submissionId: id }, orderBy: { order: 'asc' } });
  expect(before).toHaveLength(8);
  for (const p of before) {
    const elements = JSON.parse(p.sceneJson).elements;
    expect(elements).toHaveLength(2);
    expect(elements[0].text).toBe(`Unique text ${p.pageLabel}`);
    expect(elements[1].type).toBe('shape');
  }
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('Eight-page browser regression');
  const reopened = await page.request.get(`/api/submissions/${id}`);
  expect(reopened.ok()).toBe(true);
  expect((await reopened.json()).submission.pages.map((p: { sceneJson: string }) => p.sceneJson)).toEqual(before.map(p => p.sceneJson));
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Queued for rendering…', { exact: false })).toBeVisible();
  const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: id } });
  expect(job.status).toBe('QUEUED');
  expect(job.attempts).toBe(0);
  expect(parseRenderSnapshot(job.inputSnapshot).pages.map(p => p.scene)).toEqual(before.map(p => JSON.parse(p.sceneJson)));
});

test('persists guided book styling through authenticated APIs and freezes qualified fonts', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Émilie and the sea');
  await page.getByLabel('Design scope', { exact: true }).selectOption('book');
  await page.getByRole('button', { name: /^Modern Minimal/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const pages = await db.submissionPage.findMany({ where: { submissionId: id } });
  expect(pages).toHaveLength(8);
  expect(pages.every(p => JSON.parse(p.sceneJson).design?.presetId === 'modern')).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Modern Minimal/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Submit For PDF', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: id } });
  const input = parseRenderSnapshot(job.inputSnapshot);
  expect(input.version).toBe(2);
  if (input.version !== 2) throw new Error('Expected a qualified snapshot');
  expect(Object.keys(input.typography!.fonts)).toContain('source-sans-3-400-normal');
  expect(input.pages.find(p => p.pageLabel === 'FRONT_COVER')!.scene.elements[0]).toMatchObject({ text: 'Émilie and the sea', fontFamily: 'Source Sans 3', typographyVersion: 1 });
});

test('failed saves block navigation and submission and recover after retry', async ({ page }) => {
  const id = await openDraft(page);
  let submitRequests = 0;
  page.on('request', request => { if (request.url().endsWith(`/api/submissions/${id}/submit`)) submitRequests++; });
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
  await addText(page, 'Keep this unsaved text');
  await page.getByRole('button', { name: 'Edit Page 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Element text' })).toHaveValue('Keep this unsaved text');
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  expect(submitRequests).toBe(0);
  expect(await db.renderJob.count({ where: { submissionId: id } })).toBe(0);
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  // A successful retry unmounts this button immediately; dispatch directly so
  // Playwright does not retry the click against a detached element.
  await page.getByRole('button', { name: 'Retry saving', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Keep this unsaved text');
});

test('a stale tab cannot overwrite a newer title and retains its local edits', async ({ page, context }) => {
  const id = await openDraft(page);
  const second = await context.newPage();
  try {
    await second.goto(`/create?submissionId=${id}`);
    await expect(second.getByRole('textbox', { name: 'Book title' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Book title' }).fill('Newer server title');
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    await second.getByRole('textbox', { name: 'Book title' }).fill('Stale tab local title');
    await expect(second.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Newer server title');
    await expect(second.getByRole('textbox', { name: 'Book title' })).toHaveValue('Stale tab local title');
    const recovery = await second.evaluate(key => localStorage.getItem(key), `titchybook-recovery:${userId}:${id}`);
    expect(JSON.parse(recovery!).parts.title.value).toBe('Stale tab local title');
  } finally { await second.close(); }
});

test('applies AI text across pages only after the outgoing save succeeds', async ({ page }) => {
  const id = await openDraft(page);
  const suggestion = JSON.stringify({ message: 'Suggested text', suggestions: [{ id: 'ai-one', label: 'Page two text', targetPage: 'PAGE_2', text: 'AI text for page two' }] });
  await page.route('**/api/ai/chat', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ token: suggestion })}\n\ndata: {"done":true}\n\n` }));
  await page.route(`**/api/submissions/${id}/pages/FRONT_COVER`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected failure"}' }) : route.continue());
  await addText(page, 'Outgoing text');
  await page.getByRole('button', { name: 'AI Assistant', exact: true }).click();
  await page.getByPlaceholder('Ask me to write something...').fill('Write page two');
  await page.getByPlaceholder('Ask me to write something...').press('Enter');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.unroute(`**/api/submissions/${id}/pages/FRONT_COVER`);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Applied', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const pages = await db.submissionPage.findMany({ where: { submissionId: id }, orderBy: { order: 'asc' } });
  expect(JSON.parse(pages[0].sceneJson).elements[0].text).toBe('Outgoing text');
  expect(JSON.parse(pages[2].sceneJson).elements[0].text).toBe('AI text for page two');
});

test('restores local unsaved edits after reload without creating another draft', async ({ page }) => {
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.abort() : route.continue());
  await addText(page, 'Recover after reload');
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Recover after reload');
  expect(await db.submission.count({ where: { userId } })).toBe(1);
});

test('arrow buttons navigate in reading order and commit the outgoing save', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Arrow navigation text');
  await expect(page.getByText('Page 1 of 8', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Page 2 of 8', { exact: true })).toBeVisible();
  // The switch only commits after the outgoing page flushed successfully.
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Arrow navigation text');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  // The filmstrip jumps anywhere; Next is disabled at the reading-order end.
  await page.getByRole('button', { name: 'Edit Back Cover', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Back Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Page 8 of 8', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
});

test('keyboard arrows navigate pages but never while typing in a field', async ({ page }) => {
  await openDraft(page);
  const front = page.getByRole('button', { name: 'Edit Front Cover', exact: true });
  const second = page.getByRole('button', { name: 'Edit Page 2', exact: true });
  await page.getByRole('button', { name: 'Next page', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(second).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowLeft');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // Arrow keys belong to the caret while the title field has focus.
  await page.getByRole('textbox', { name: 'Book title' }).fill('Keyboard guard');
  await page.keyboard.press('ArrowRight');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // Same inside the element text field.
  await addText(page, 'Typing guard');
  await page.keyboard.press('ArrowRight');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // PageDown/PageUp mirror the arrows outside form controls.
  await page.getByRole('button', { name: 'Next page', exact: true }).focus();
  await page.keyboard.press('PageDown');
  await expect(second).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('PageUp');
  await expect(front).toHaveAttribute('aria-current', 'page');
});

test.describe('touch swipe navigation', () => {
  test.use({ hasTouch: true });

  async function swipe(page: Page, fromX: number, fromY: number, dx: number) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + (dx * step) / 6, y: fromY }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('swiping the stage background navigates and a failed save blocks it', async ({ page }) => {
    const id = await openDraft(page);
    const stage = page.locator('.konvajs-content');
    await expect(stage).toBeVisible();
    const box = (await stage.boundingBox())!;
    // Gesture stays on empty background well below any placed element.
    const y = box.y + box.height * 0.85;
    const distance = Math.min(200, box.width * 0.6);
    await swipe(page, box.x + box.width * 0.8, y, -distance);
    await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
    await swipe(page, box.x + box.width * 0.2, y, distance);
    await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
    // An injected save failure blocks the swipe exactly like a click.
    await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
    await addText(page, 'Swipe blocked text');
    await swipe(page, box.x + box.width * 0.8, y, -distance);
    await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Element text' })).toHaveValue('Swipe blocked text');
  });
});

test('booklet preview shows all eight pages and jumps straight to a page', async ({ page }) => {
  await openDraft(page);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Preview overview book');
  await addText(page, 'Front cover words');
  await page.getByRole('button', { name: 'Preview booklet', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Preview overview book' })).toBeVisible();
  for (const label of PAGE_LABELS) {
    await expect(dialog.getByRole('button', { name: `Go to ${PAGE_LABEL_DISPLAY[label]}`, exact: true })).toBeVisible();
    await expect(dialog.getByAltText(`${PAGE_LABEL_DISPLAY[label]} booklet preview`)).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Go to Page 4', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Page 4', exact: true })).toHaveAttribute('aria-current', 'page');
  // Escape closes the dialog and focus returns to the trigger button.
  await page.getByRole('button', { name: 'Preview booklet', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Preview booklet', exact: true })).toBeFocused();
});

test('canvas stays visible while the tools rail scrolls independently', async ({ page }) => {
  await openDraft(page);
  await addText(page, 'Rail scroll visibility');
  const rail = page.getByTestId('editor-tools-rail');
  const stage = page.locator('.konvajs-content');
  const viewport = page.viewportSize()!;
  // At xl the rail owns its overflow; the document itself must not scroll.
  expect(await rail.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await rail.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The deepest rail content is reachable inside the viewport...
  const deepHint = rail.getByText('Click any thumbnail to place another copy on the current page.');
  const hintBox = (await deepHint.boundingBox())!;
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height);
  // ...while the canvas remains fully in view at the same time.
  const box = (await stage.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // Editing a property auto-scrolls the rail, never the page or the canvas.
  await page.getByRole('textbox', { name: 'Element text', exact: true }).fill('Edited from the rail');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await stage.boundingBox()).toEqual(box);
});

test('save-error banner shrinks the frame instead of pushing the rail off-screen', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Banner frame text');
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  // The failed flush blocks navigation and mounts the alert banner.
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('alert').filter({ hasText: 'Injected save failure' })).toBeVisible();
  const rail = page.getByTestId('editor-tools-rail');
  const viewport = page.viewportSize()!;
  // The banner lives inside the height-constrained frame, so the document
  // still does not scroll and the deepest rail content stays reachable.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await rail.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const deepHint = rail.getByText('Click any thumbnail to place another copy on the current page.');
  const hintBox = (await deepHint.boundingBox())!;
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height);
  const stageBox = (await page.locator('.konvajs-content').boundingBox())!;
  expect(stageBox.y).toBeGreaterThanOrEqual(0);
  expect(stageBox.y + stageBox.height).toBeLessThanOrEqual(viewport.height);
});

test('double-click edits text directly inside the canvas text box', async ({ page }) => {
  await openDraft(page);
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  const stage = page.locator('.konvajs-content');
  const box = (await stage.boundingBox())!;
  // The default text box starts at scene (72, 88) on a 700x1000 page; aim
  // at the first line's glyphs because Konva hit-testing is pixel-based.
  const textPoint = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.105 };
  const inline = page.getByRole('textbox', { name: 'Edit text on page' });
  const railText = page.getByRole('textbox', { name: 'Element text', exact: true });
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await expect(inline).toHaveValue('Add your story here');
  await inline.fill('Typed directly on the page');
  await inline.press('Control+Enter');
  await expect(inline).toHaveCount(0);
  await expect(railText).toHaveValue('Typed directly on the page');
  // A whole editing session is a single undo step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(railText).toHaveValue('Add your story here');
  // Escape cancels without touching the stored text.
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await inline.fill('Discarded edit');
  await inline.press('Escape');
  await expect(inline).toHaveCount(0);
  await expect(railText).toHaveValue('Add your story here');
  // Clicking away (blur) commits the edit.
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await inline.fill('Committed by blur');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await expect(inline).toHaveCount(0);
  // The background click also deselects; reselect to inspect the commit.
  await page.mouse.click(textPoint.x, textPoint.y);
  await expect(railText).toHaveValue('Committed by blur');
  // Ending the inline session must bring the resize controls back: dragging
  // the top-left Transformer anchor resizes the box instead of moving it.
  const widthInput = page.locator('label:has(span:text-is("Width")) + input');
  const widthBefore = await widthInput.inputValue();
  const scale = box.width / 700;
  const corner = { x: box.x + 72 * scale, y: box.y + 88 * scale };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(widthInput).not.toHaveValue(widthBefore);
});

test('Add Shape menu paints above the background color picker', async ({ page }) => {
  await openDraft(page);
  // Below md the page-info row stacks left-aligned, putting the picker
  // trigger under the toolbar's Add Shape menu. Zooming out lets the
  // toolbar fit one row (media queries stay viewport-based), which brings
  // the open menu down over the picker exactly like a zoomed-out window.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '0.75'; });
  await page.getByRole('button', { name: 'Add Shape' }).hover();
  const menu = page.getByTestId('add-shape-menu');
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  const triggerBoxes = [
    await page.getByRole('button', { name: /Open color picker/ }).boundingBox(),
    await page.getByPlaceholder('#000000').boundingBox(),
  ];
  const centers = triggerBoxes
    .filter((box): box is NonNullable<typeof box> => Boolean(box))
    .map(box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));
  const overlap = centers.find(point =>
    point.x >= menuBox.x && point.x <= menuBox.x + menuBox.width &&
    point.y >= menuBox.y && point.y <= menuBox.y + menuBox.height);
  expect(overlap, `menu ${JSON.stringify(menuBox)} must overlap picker ${JSON.stringify(triggerBoxes)}`).toBeTruthy();
  // Hit-testing proves paint order: the topmost node at the shared point
  // must belong to the menu, not the swatch/hex input painted over it.
  const topIsMenu = await page.evaluate(([x, y]) => {
    const node = document.elementFromPoint(x, y);
    return Boolean(node && node.closest('[data-testid="add-shape-menu"]'));
  }, [overlap!.x, overlap!.y]);
  expect(topIsMenu).toBe(true);
  // Playwright's hit-target check also rejects an obscured menu click.
  await menu.getByRole('button', { name: 'Rectangle', exact: true }).click();
});
