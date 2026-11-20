// The editor's blocks in a real browser: the slash menu by keyboard and mouse, the embed, footnote
// and snippet dialogs, an image dropped in, and the post's search fields. Saved, reloaded, shown in
// the email preview and on the website, so a document with these nodes is proved to round-trip.
import { expect, test, type Page } from '@playwright/test';
import {
  PNG,
  expectAccessible,
  expectPostSaved,
  insertBlock,
  newPost,
  openMoreOptions,
  openSection,
  postBody,
  postSettings,
} from './helpers';
import { api, publication, shot } from './screens';

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}

const types = (nodes: Node[] = []): string[] =>
  nodes.flatMap((node) => [node.type, ...types(node.content)]);

/** Drops a file on the editor the way a browser does, with the file in the event's data. */
async function dropImage(page: Page) {
  await postBody(page).evaluate(
    (body, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
      const box = body.getBoundingClientRect();
      body.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: box.left + 20,
          clientY: box.bottom - 8,
        }),
      );
    },
    [...PNG],
  );
}

test('every block survives a save and a reload, and shows in the preview and on the site', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const site = await publication(page, request, 'blocks', ['snippets']);
  await page.goto('/');
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('Every block we have');
  const body = postBody(page);
  // The last line of the document. The editor always keeps one after a block.
  const toEnd = async () => {
    await body.locator(':scope > p').last().click();
    await page.keyboard.press('End');
  };
  await body.click();
  await page.keyboard.type('Opening paragraph');
  await page.keyboard.press('Enter');

  // The slash menu by keyboard: filter, arrows, Enter.
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Insert a block' });
  await expect(menu).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'editor-slash');
  await page.keyboard.type('call');
  await expect(menu.getByRole('option', { name: 'Callout' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('Inside the callout');
  await expect(body.locator('aside[data-callout]')).toContainText('Inside the callout');
  await expect(body).not.toContainText('/call');

  // Leaving the callout: the document keeps a line after it.
  await toEnd();
  await page.keyboard.type('After the callout');
  await page.keyboard.press('Enter');

  // Escape closes the menu and leaves the text.
  await page.keyboard.type('/e');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  // The slash menu by mouse.
  await page.keyboard.type('/');
  await menu.getByRole('option', { name: 'Two columns' }).click();
  await expect(body.locator('div[data-columns] div[data-column]')).toHaveCount(2);
  // Writing starts in the first column.
  await page.keyboard.type('Left column text');
  await expect(body.locator('div[data-column]').first()).toContainText('Left column text');
  await body.locator('div[data-column]').nth(1).click();
  await page.keyboard.type('Right column text');
  await shot(page, 'editor-columns');

  // Embed, from the slash menu: a link from elsewhere is refused, a known one goes in.
  await toEnd();
  await page.keyboard.type('/embed');
  await page.keyboard.press('Enter');
  const embed = page.getByRole('dialog', { name: 'Embed' });
  await expect(embed).toBeVisible();
  await embed.getByLabel('Link').fill('https://example.com/video');
  await expect(embed.getByText('That link isn’t from one of these services.')).toBeVisible();
  await expect(embed.getByRole('button', { name: 'Insert' })).toBeDisabled();
  await expectAccessible(page);
  await embed.getByLabel('Link').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await embed.getByRole('button', { name: 'Insert' }).click();
  await expect(body.locator('div[data-embed]')).toBeVisible();

  // A footnote on a line of text.
  await toEnd();
  await page.keyboard.type('A claim with a source');
  await insertBlock(page, 'Footnote');
  const footnote = page.getByRole('dialog', { name: 'Footnote' });
  await footnote.getByLabel('Note').fill('The source of the claim.');
  await expectAccessible(page);
  await footnote.getByRole('button', { name: 'Insert' }).click();
  await expect(body.locator('sup[data-footnote]')).toBeVisible();
  await expect(body).toBeFocused();

  // Snippets: save what's selected, then insert a copy elsewhere.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Yours in the field');
  await body.getByText('Yours in the field').click({ clickCount: 3 });
  await insertBlock(page, 'Snippet');
  const snippets = page.getByRole('dialog', { name: 'Snippets' });
  await expect(snippets.getByText(/No snippets yet/)).toBeVisible();
  await snippets.getByLabel('Save the selected text as').fill('Sign-off');
  await snippets.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(snippets.getByText('Sign-off', { exact: true })).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'editor-snippets');
  await snippets.getByRole('button', { name: 'Close' }).click();
  await expect(snippets).toHaveCount(0);
  await toEnd();
  // The editor reads a click's new selection a moment later. Enter straight away, faster than anyone
  // types, would still act on the old selection and replace it.
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await insertBlock(page, 'Snippet');
  await snippets.getByRole('button', { name: 'Insert Sign-off', exact: true }).click();
  await expect(body.getByText('Yours in the field')).toHaveCount(2);

  // An image dropped in goes to the media library and lands in the post.
  await dropImage(page);
  const dropped = body.locator('img[data-media-id]');
  await expect(dropped).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(() => dropped.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);

  await expectPostSaved(page);
  await shot(page, 'editor-all-blocks');
  await expectAccessible(page);

  // The post's search fields, saved when a field is left.
  await openMoreOptions(page);
  const panel = postSettings(page);
  await panel.getByLabel('Search title').fill('A search title for every block');
  await panel.getByLabel('Search description').fill('What the blocks look like in a search.');
  await panel.getByLabel('Web address').click();
  await expect
    .poll(async () => {
      const id = /\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];
      const post = await api<{ seoDescription: string }>(page, 'GET', `/api/v1/dispatches/${id}`);
      return post.seoDescription;
    })
    .toBe('What the blocks look like in a search.');
  await expectAccessible(page);
  await shot(page, 'editor-website-panel');

  // Reload: everything is still there, in the editor and in the stored document.
  await expect(body).toBeVisible();
  await page.reload();
  await expect(body.locator('aside[data-callout]')).toContainText('Inside the callout');
  await expect(body.locator('div[data-column]').first()).toContainText('Left column text');
  await expect(body.locator('div[data-column]').nth(1)).toContainText('Right column text');
  await expect(body.locator('div[data-embed]')).toContainText('dQw4w9WgXcQ');
  await expect(body.locator('sup[data-footnote]')).toHaveAttribute(
    'data-text',
    'The source of the claim.',
  );
  await expect(dropped).toBeAttached();
  await expect(body.getByText('Yours in the field')).toHaveCount(2);
  const id = /\/([^/]+)$/.exec(new URL(page.url()).pathname)?.[1];
  const stored = await api<{ content: Node; seoTitle: string }>(
    page,
    'GET',
    `/api/v1/dispatches/${id}`,
  );
  expect(stored.seoTitle).toBe('A search title for every block');
  const kinds = types(stored.content.content);
  for (const kind of ['callout', 'columns', 'column', 'embed', 'footnote', 'image']) {
    expect(kinds, kind).toContain(kind);
  }

  // The email preview shows each of them.
  await page.getByRole('radio', { name: 'Email · desktop' }).check({ force: true });
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByText('Inside the callout')).toBeVisible();
  await expect(preview.getByText('Left column text')).toBeVisible();
  await expect(preview.getByText('Right column text')).toBeVisible();
  await expect(preview.getByRole('link', { name: /Watch on YouTube/ }).first()).toBeVisible();
  await expect(preview.getByText('The source of the claim.')).toBeVisible();
  await expect(preview.locator('body img').first()).toBeAttached();
  await shot(page, 'editor-email-preview');
  await page.getByRole('radio', { name: 'Edit' }).check({ force: true });

  // On the website.
  await openMoreOptions(page);
  await panel.getByRole('button', { name: 'Publish to web only' }).click();
  await expect(panel.getByText('On the website', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  const visit = await page.context().newPage();
  await visit.goto(`${site.origin}/p/every-block-we-have`);
  await expect(visit.getByText('Inside the callout')).toBeVisible();
  await expect(visit.getByText('Left column text')).toBeVisible();
  await expect(visit.getByText('Right column text')).toBeVisible();
  await expect(visit.getByRole('link', { name: /Watch on YouTube/ })).toBeVisible();
  await expect(visit.getByText('The source of the claim.')).toBeVisible();
  await expect(visit.getByText('Yours in the field')).toHaveCount(2);
  const img = visit.locator('main img').first();
  await expect(img).toBeAttached();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(visit).toHaveTitle(/A search title for every block/);
  await expect(visit.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'What the blocks look like in a search.',
  );
  await shot(visit, 'editor-on-site');
  await visit.close();
});
