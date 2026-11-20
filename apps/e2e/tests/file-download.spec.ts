import { expect, test, type Page } from '@playwright/test';
import {
  API,
  chooseEveryone,
  createPublication,
  expectAccessible,
  expectPostSaved,
  insertBlock,
  newPost,
  openSection,
  postBody,
  sendNow,
  signIn,
} from './helpers';

async function addMember(page: Page, channelId: string, email: string) {
  const status = await page.evaluate(
    async ({ channelId, email }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true }),
      });
      return res.status;
    },
    { channelId, email },
  );
  expect(status).toBe(201);
}

test('a writer adds a PDF to a post, and subscribers get a link to it, not the file', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const readers = [`file-a-${stamp}@example.org`, `file-b-${stamp}@example.org`];

  await page.goto('/');
  await signIn(page, request, `file-${stamp}@example.com`);
  await createPublication(page, 'Handouts', `file-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  for (const email of readers) await addMember(page, channelId, email);

  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('This week’s handout');
  await postBody(page).click();
  await page.keyboard.type('The handout is below.');
  await page.keyboard.press('Enter');

  await insertBlock(page, 'File');
  const dialog = page.getByRole('dialog', { name: 'Attach a file' });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

  // Anything else is refused, whatever it calls itself.
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'not-really.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<script>alert(1)</script>'),
  });
  await expect(dialog.getByRole('alert')).toBeVisible();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'handout.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await expect(dialog.getByRole('button', { name: 'Insert file' })).toBeEnabled();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Insert file' }).click();
  await expectPostSaved(page);

  await chooseEveryone(page);
  await sendNow(page, 2);
  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });

  // The email carries a link to the file, and no file. The file behind it can't run script.
  let mail: { subject: string; html: string; text: string } | null = null;
  await expect
    .poll(async () => {
      const res = await request.get(
        `${API}/__dev/mail/latest.json?to=${encodeURIComponent(readers[0]!)}`,
      );
      if (res.status() !== 200) return null;
      mail = ((await res.json()) as { data: NonNullable<typeof mail> }).data;
      return mail.subject;
    })
    .toBe('This week’s handout');
  expect(JSON.stringify(mail)).not.toContain('multipart/mixed');
  // The link is click-tracked, as every link in a send is; following it reaches the file.
  // The attachment is a bordered table cell holding one link.
  const link = /class="sw-attachment[^"]*"[\s\S]*?<a [^>]*href="([^"]+)"/
    .exec(mail!.html)?.[1]
    ?.replaceAll('&amp;', '&');
  expect(link, 'a download link in the email').toBeTruthy();
  expect(mail!.html).toContain('Download PDF');
  const download = await request.get(link!);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toBe('application/pdf');
  expect(download.headers()['x-content-type-options']).toBe('nosniff');
  expect((await download.body()).equals(pdf)).toBe(true);
});
