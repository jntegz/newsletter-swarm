// Website → Design through its real screens: pick a template, change the accent, add a section and
// fill a list, show a section to visitors only, edit the code with the preview following, see a
// problem the moment a <script> is typed, publish, and restore a version into the draft.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, publication, shot } from './screens';

interface Section {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  audience?: string;
}
interface Design {
  theme: string;
  files: Record<string, string> | null;
  settings: Record<string, unknown>;
  sections: Section[] | null;
}
interface DesignState {
  draft: Design;
  published: Design | null;
  problems: { file: string; line: number; message: string; severity: string }[];
}

const designOf = (page: Page, id: string) =>
  api<DesignState>(page, 'GET', `/api/v1/channels/${id}/site/design`);

/** The draft as the server has it, once the studio has saved what was just done. */
async function savedDraft(page: Page, id: string): Promise<Design> {
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();
  return (await designOf(page, id)).draft;
}

const preview = (page: Page) =>
  page.frameLocator('iframe[title^="Preview of the home page"]:not(.invisible)');

test('Design: template, style, sections, code, problems, publish and restore', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const site = await publication(page, request, 'design', ['site_templates']);
  await page.goto(`/site/${site.id}/design`);
  const panel = page.getByRole('tabpanel');
  await expect(page.getByRole('tab', { name: 'Template', selected: true })).toBeVisible();
  await expect(preview(page).locator('h1')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'design-template');

  // Template: switching keeps the words and the style, and says so with Undo.
  await panel.getByRole('button', { name: /^Letter/ }).click();
  await expect(page.getByText(/^Now using Letter/)).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Letter/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(async () => (await savedDraft(page, site.id)).theme).toBe('letter');

  // Style: the accent, typed as hex.
  await page.getByRole('tab', { name: 'Style' }).click();
  const accent = panel.getByRole('textbox', { name: 'Accent', exact: true });
  await accent.fill('#b4235f');
  await accent.press('Tab');
  await expect.poll(async () => (await savedDraft(page, site.id)).settings.accent).toBe('#b4235f');
  await expectAccessible(page);
  await shot(page, 'design-style');

  // Sections: add testimonials with two quotes.
  await page.getByRole('tab', { name: 'Sections' }).click();
  await panel.getByRole('button', { name: 'Add section' }).click();
  await page
    .getByRole('group', { name: 'Sections you can add' })
    .getByRole('button', { name: /^Testimonials/ })
    .click();
  await expect(panel.getByRole('heading', { name: 'Testimonials', level: 2 })).toBeVisible();
  const quotes = [
    ['The one email I read on a Sunday.', 'Ada Okafor'],
    ['Short, kind and always worth it.', 'Ben Hartley'],
  ] as const;
  for (const [quote, name] of quotes) {
    await panel.getByRole('button', { name: /^Add item/ }).click();
    await panel.getByLabel('Quote', { exact: true }).fill(quote);
    await panel.getByLabel('Name', { exact: true }).fill(name);
  }
  const added = async () =>
    (await savedDraft(page, site.id)).sections?.filter((s) => s.type === 'testimonials').at(-1);
  await expect
    .poll(async () =>
      ((await added())?.settings.items as { name: string }[] | undefined)?.map((i) => i.name),
    )
    .toEqual(['Ada Okafor', 'Ben Hartley']);
  await expect(preview(page).getByText('Short, kind and always worth it.')).toBeVisible();

  // Who sees it: visitors only, so subscribers don't see it.
  await panel
    .getByRole('group', { name: 'Who sees it' })
    .getByText('Visitors', { exact: true })
    .click();
  await expect.poll(async () => (await added())?.audience).toBe('visitors');
  const sectionId = (await added())!.id;
  await page.getByLabel('Preview as').selectOption('subscriber');
  await expect(preview(page).locator(`#section-${sectionId}`)).toHaveCount(0);
  await page.getByLabel('Preview as').selectOption('visitor');
  await expect(preview(page).locator(`#section-${sectionId}`)).toBeVisible();
  await panel.getByRole('button', { name: 'All sections' }).click();
  await expect(
    panel.getByRole('button', { name: /^Testimonials.*Visitors only/ }).last(),
  ).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'design-sections');

  // Code: Edit code copies the files; a line added to the hero reaches the preview.
  await page.getByRole('tab', { name: 'Code' }).click();
  await panel.getByRole('button', { name: 'Edit code' }).click();
  await expect(page.getByText(/files are now this design’s own/)).toBeVisible();
  await panel
    .getByRole('navigation', { name: 'Theme files' })
    .getByRole('button', { name: 'hero', exact: true })
    .click();
  const editor = panel.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('<p class="ribbon">New this week</p>');
  // Esc closes the completion list, so Enter is a new line.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await savedDraft(page, site.id)).files?.['sections/hero.html'] ?? '')
    .toContain('New this week');
  await expect(preview(page).getByText('New this week')).toBeVisible();

  // A script is a problem at once, with its file, line and column, and Publish waits for it.
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('<script>alert(1)</script>');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  const problem = panel.getByRole('button', { name: /sections\/hero\.html:1:1/ });
  await expect(problem).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await expectAccessible(page);
  await shot(page, 'design-code-problem');
  // Esc then Tab leaves the editor: the keyboard is never trapped.
  await editor.click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  // Take the script line out again.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Backspace');
  await expect(panel.getByText(/^No problems/)).toBeVisible();

  // Publish: the site shows the new line.
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/^Published\. The home page/)).toBeVisible();
  const live = await designOf(page, site.id);
  expect(live.published?.files?.['sections/hero.html']).toContain('New this week');
  const reader = await browser.newPage();
  await reader.goto(`${site.origin}/`);
  await expect(reader.getByText('New this week')).toBeVisible();
  await reader.close();

  // Restore: change the accent, then put the published version back into the draft.
  await page.getByRole('tab', { name: 'Style' }).click();
  await panel.getByRole('textbox', { name: 'Accent', exact: true }).fill('#2f5d50');
  await expect.poll(async () => (await savedDraft(page, site.id)).settings.accent).toBe('#2f5d50');
  await page.getByRole('button', { name: 'Versions' }).click();
  const versions = page.getByRole('dialog', { name: 'Versions' });
  await expect(versions.getByText('Live now')).toBeVisible();
  await expectAccessible(page);
  await versions
    .getByRole('button', { name: /^Restore the version/ })
    .first()
    .click();
  await expect(page.getByText(/The draft is back to what’s live/)).toBeVisible();
  await expect
    .poll(async () => (await designOf(page, site.id)).draft.settings.accent)
    .toBe('#b4235f');
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();
  await expect(page.getByText(/^Published \d/)).toBeVisible();
  await shot(page, 'design-restored');
});
