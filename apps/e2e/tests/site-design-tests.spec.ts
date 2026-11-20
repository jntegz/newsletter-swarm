// A/B tests on a section, through the design studio's real screens (docs/site-themes.md): start a
// test on the hero, change B's heading and see B in the preview (Preview as Variant B too), read
// the results card and its numbers, then Use B: B's heading becomes the hero's own, with Undo.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, publication, shot } from './screens';

interface Section {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  experiment?: {
    id: string;
    status: 'running' | 'ended';
    variantB: Record<string, unknown>;
    winner?: 'a' | 'b';
  };
}
interface Design {
  sections: Section[] | null;
}

const draftOf = async (page: Page, id: string) =>
  (await api<{ draft: Design }>(page, 'GET', `/api/v1/channels/${id}/site/design`)).draft;

/** The hero as the server has it, once the studio has saved what was just done. */
async function savedHero(page: Page, id: string): Promise<Section | undefined> {
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();
  return (await draftOf(page, id)).sections?.find((s) => s.type === 'hero');
}

const preview = (page: Page) =>
  page.frameLocator('iframe[title^="Preview of the home page"]:not(.invisible)');

test('Design: test a variant of a section, see B in the preview, and use B', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'abtest', ['site_templates']);
  await page.goto(`/site/${site.id}/design?panel=sections`);
  const panel = page.getByRole('tabpanel');

  // The numbers and their period sit above the sections.
  await expect(panel.getByRole('group', { name: 'Numbers for the last' })).toBeVisible();
  await panel.getByText('7 days', { exact: true }).click();

  // Start a test on the hero: B starts as a copy of A, and its settings open on B.
  await panel.getByRole('button', { name: /^More for Hero/ }).click();
  await page.getByRole('button', { name: /^Test a variant/ }).click();
  await expect(page.getByText(/^Testing a variant of Hero/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'A/B test' })).toBeVisible();
  await expect(panel.getByText('Not published yet')).toBeVisible();
  await expect
    .poll(async () => (await savedHero(page, site.id))?.experiment?.status)
    .toBe('running');

  // Edit B: the heading changes for B only, and the preview shows B.
  await expect(
    panel.getByRole('group', { name: 'Edit variant' }).getByRole('radio', { name: /^B/ }),
  ).toBeChecked();
  await panel.getByLabel('Heading', { exact: true }).fill('A walk a week, in your inbox');
  await expect
    .poll(async () => (await savedHero(page, site.id))?.experiment?.variantB.heading)
    .toBe('A walk a week, in your inbox');
  expect((await savedHero(page, site.id))?.settings.heading ?? '').not.toBe(
    'A walk a week, in your inbox',
  );
  await expect(preview(page).locator('h1')).toHaveText('A walk a week, in your inbox');
  await expectAccessible(page);
  await shot(page, 'design-test-b');

  // Back on A, the preview shows A; Preview as Variant B shows B again.
  await panel
    .getByRole('group', { name: 'Edit variant' })
    .getByText(/^A, the original/)
    .click();
  await expect(preview(page).locator('h1')).not.toHaveText('A walk a week, in your inbox');
  await page.getByLabel('Preview as').selectOption('variant-b');
  await expect(preview(page).locator('h1')).toHaveText('A walk a week, in your inbox');
  await page.getByLabel('Preview as').selectOption('visitor');

  // The list says the test is running.
  await panel.getByRole('button', { name: 'All sections' }).click();
  await expect(panel.getByRole('button', { name: /^Hero.*A\/B test running/ })).toBeVisible();
  await expectAccessible(page);

  // Publish starts it on the site.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/^Published\. The home page/)).toBeVisible();

  // Use B: B's heading becomes the hero's own and the test ends, with Undo.
  await panel.getByRole('button', { name: /^Hero/ }).first().click();
  await expect(panel.getByText(/views, not people/)).toBeVisible();
  await panel.getByRole('button', { name: 'Use B' }).click();
  await expect(page.getByText(/^Test ended: B is now Hero’s settings/)).toBeVisible();
  await expect
    .poll(async () => (await savedHero(page, site.id))?.settings.heading)
    .toBe('A walk a week, in your inbox');
  const ended = await savedHero(page, site.id);
  expect(ended?.experiment).toMatchObject({ status: 'ended', winner: 'b' });
  await expect(panel.getByText(/^Ended .*, B used$/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'design-test-ended');
});
