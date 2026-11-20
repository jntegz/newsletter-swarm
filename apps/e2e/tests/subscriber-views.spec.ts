import { expect, test, type Page } from '@playwright/test';
import { createPublication, expectAccessible, localSql, openSection, signIn } from './helpers';

/** Adds a confirmed subscriber through the API, as the signed-in operator in the page. */
async function addMember(page: Page, channelId: string, email: string, tags: string[]) {
  const status = await page.evaluate(
    async ({ channelId, email, tags }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true, tags }),
      });
      return res.status;
    },
    { channelId, email, tags },
  );
  expect(status).toBe(201);
}

async function session(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { headers: { accept: 'application/json' } });
    const { data } = (await res.json()) as {
      data: { operator: { id: string }; workspaces: { id: string }[] };
    };
    return { operatorId: data.operator.id, workspaceId: data.workspaces[0]!.id };
  });
}

test('filters live in the address, a saved view is shared with the team, and the list works from the keyboard', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const owner = `views-${stamp}@example.com`;
  const paid = [`paid-a-${stamp}@example.org`, `paid-b-${stamp}@example.org`];
  const free = `free-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Garden Letters', `views-${stamp.toString(36)}`);
  await openSection(page, 'Subscribers');
  const channelId = new URL(page.url()).searchParams.get('channel')!;
  for (const email of paid) await addMember(page, channelId, email, ['paid']);
  await addMember(page, channelId, free, []);
  await page.reload();

  // Filters go into the address, so a reload (or a bookmark) shows the same list.
  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: /^Active/ })
    .click();
  await page.getByRole('combobox', { name: 'Tag', exact: true }).selectOption('paid');
  await expect(page).toHaveURL(/status=active/);
  await expect(page).toHaveURL(/tag=paid/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Tag', exact: true })).toHaveValue('paid');
  await expect(page.getByRole('row', { name: new RegExp(paid[0]!) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(free) })).toHaveCount(0);

  // Every control in the toolbar row is the same height.
  for (const control of [
    page.getByRole('searchbox', { name: 'Search' }),
    page.getByRole('combobox', { name: 'Tag', exact: true }),
    page.getByRole('button', { name: 'Columns' }),
    page.getByRole('button', { name: /^Views/ }),
  ]) {
    expect((await control.boundingBox())?.height).toBe(36);
  }

  // Save the filters as a view; it becomes the named, active view.
  await page.getByRole('button', { name: /^Views/ }).click();
  await expect(page.getByText('No saved views yet.')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: /^Save view/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  await expect(dialog).toContainText('Saves Active · Tag paid');
  await dialog.getByLabel('Name').fill('Paid readers');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the view' })).toContainText(
    'Paid readers',
  );
  await expect(page.getByRole('button', { name: /View: Paid readers/ })).toBeVisible();

  // Changing a filter leaves the view; choosing it again brings its filters back.
  await page.getByRole('searchbox', { name: 'Search' }).fill('paid-a');
  await expect(page).toHaveURL(/q=paid-a/);
  await expect(page.getByRole('button', { name: /^Views/ })).toBeVisible();
  await page.getByRole('button', { name: /^Views/ }).click();
  await page.getByRole('button', { name: /^Paid readers/ }).click();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  await expect(page.getByRole('row', { name: new RegExp(paid[1]!) })).toBeVisible();

  // The keyboard: / searches, the arrow keys move between rows, x selects, Enter opens.
  await page.getByRole('heading', { level: 1, name: 'Subscribers' }).click();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search' })).toBeFocused();
  const rows = page.getByRole('table').getByRole('row');
  const first = (await rows.nth(1).getByRole('button').innerText()).trim();
  const second = (await rows.nth(2).getByRole('button').innerText()).trim();
  await rows.nth(1).getByRole('button', { name: first }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: second })).toBeFocused();
  await page.keyboard.press('x');
  await expect(page.getByLabel(`Select ${second}`)).toBeChecked();
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('1 selected');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: first })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: first })).toBeFocused();

  // The command menu lists the publication's views.
  await page.goto(`/members?channel=${channelId}`);
  // The shortcut belongs to the app, which has to have started before it can hear it.
  await expect(page.getByRole('heading', { name: 'Subscribers', level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await menu.getByRole('group', { name: 'Subscriber views' }).getByText('Paid readers').click();
  await expect(page).toHaveURL(/tag=paid/);
  await expect(page.getByRole('button', { name: /View: Paid readers/ })).toBeVisible();

  // A viewer on the team sees the view and can use it, but can't save or delete views.
  const { workspaceId } = await session(page);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto('/');
  await signIn(viewer, request, `views-viewer-${stamp}@example.com`);
  const { operatorId } = await session(viewer);
  const now = Date.now();
  localSql(
    `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES ('st_${stamp.toString(16).padStart(32, '0').slice(-32)}', '${workspaceId}', '${operatorId}', 'viewer', ${now}, ${now})`,
  );
  await viewer.goto(`/members?channel=${channelId}`);
  await viewer.getByRole('button', { name: /^Views/ }).click();
  await viewer.getByRole('button', { name: /^Paid readers/ }).click();
  await expect(viewer.getByRole('button', { name: /View: Paid readers/ })).toBeVisible();
  await expect(viewer.getByRole('row', { name: new RegExp(free) })).toHaveCount(0);
  await viewer.getByRole('button', { name: /View: Paid readers/ }).click();
  await expect(viewer.getByText('Editors and admins can save views for the team.')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Save view/ })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Delete view' })).toHaveCount(0);
  await viewerContext.close();

  // Delete the view: the list keeps its filters, and the view is gone for everyone.
  await page.getByRole('button', { name: /View: Paid readers/ }).click();
  await page.getByRole('button', { name: 'Delete view' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this view?' });
  await expectAccessible(page);
  await confirm.getByRole('button', { name: 'Delete view' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Deleted the view' })).toBeVisible();
  await expect(page).toHaveURL(/tag=paid/);
  await page.getByRole('button', { name: /^Views/ }).click();
  await expect(page.getByText('No saved views yet.')).toBeVisible();
});

test('the subscriber toolbar fits a phone and its menu stays on screen', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await signIn(page, request, `views-phone-${stamp}@example.com`);
  await createPublication(page, 'Pocket Letters', `pocket-${stamp.toString(36)}`);
  await page.goto('/members');
  await page.getByRole('button', { name: /^Views/ }).click();
  const width = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(width[0]).toBeLessThanOrEqual(width[1]!);
  const panel = await page.getByText('Saved views', { exact: true }).locator('..').boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  await expectAccessible(page);
});
