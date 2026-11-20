// Website → Design → Style with an uploaded font (docs/site-themes.md, "Uploaded fonts"): upload a
// WOFF2 from the font menu, confirming its licence allows use on a website, choose it for headings
// and see the preview load it from the site's own /media/.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, publication, shot } from './screens';

const FONT = fileURLToPath(
  new URL('../../../design/2026-11/fonts/jetbrains-mono-latin-wght-normal.woff2', import.meta.url),
);

interface DesignState {
  draft: { settings: Record<string, unknown> };
}

const preview = (page: Page) =>
  page.frameLocator('iframe[title^="Preview of the home page"]:not(.invisible)');

test('Design: upload a font, choose it for headings and see it in the preview', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'design-fonts', ['site_templates']);
  await page.goto(`/site/${site.id}/design`);
  await expect(preview(page).locator('h1')).toBeVisible();
  await page.getByRole('tab', { name: 'Style' }).click();
  const panel = page.getByRole('tabpanel');

  // The font menu ends with "Upload a font…", which opens the form under the control.
  await panel.getByRole('button', { name: /^Headings/ }).click();
  await panel.getByRole('button', { name: 'Upload a font…' }).click();
  const form = panel.getByRole('region', { name: 'Upload a font for headings' });
  await expect(form).toBeVisible();

  // The licence box is required.
  await form.locator('input[type=file]').setInputFiles(FONT);
  await form.getByRole('textbox', { name: 'Name' }).fill('JetBrains Mono');
  await form.getByRole('button', { name: 'Upload font' }).click();
  await expect(form.getByText('Confirm the licence allows use on a website.')).toBeVisible();
  await expectAccessible(page);
  await form.getByRole('checkbox', { name: 'Its licence allows use on a website' }).check();
  await form.getByRole('button', { name: 'Upload font' }).click();

  // Once uploaded it is chosen for headings, and listed under "Your fonts".
  await expect(form).toBeHidden();
  await expect(panel.getByRole('button', { name: /^Headings JetBrains Mono/ })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await api<DesignState>(page, 'GET', `/api/v1/channels/${site.id}/site/design`)).draft
          .settings.heading_font,
    )
    .toMatch(/^md_[0-9a-f]{32}$/);
  await panel.getByRole('button', { name: /^Headings/ }).click();
  await expect(page.getByRole('group', { name: 'Your fonts' })).toContainText('JetBrains Mono');
  await page.keyboard.press('Escape');

  // The preview loads the file from the site's own /media/ and draws the heading in it.
  const h1 = preview(page).locator('h1');
  await expect
    .poll(() => h1.evaluate((el) => getComputedStyle(el).fontFamily))
    .toMatch(/^"Swarm Upload [0-9a-f]{12}"/);
  await expect
    .poll(() =>
      h1.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].some(
          (face) => face.family.includes('Swarm Upload') && face.status === 'loaded',
        );
      }),
    )
    .toBe(true);
  await expectAccessible(page);
  await shot(page, 'design-uploaded-font');
});
