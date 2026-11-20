// Settings → Sending → System emails, in a real browser: the owner rewrites the confirmation email,
// refused HTML stays out, and a real signup then receives what they wrote.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, mailLink } from './helpers';
import { api, latestMail, publication, publishForm, shot, subscribeOnSite } from './screens';

const section = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'System emails' }) });

test('an owner edits a system email, and a real signup receives it', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const site = await publication(page, request, 'sysmail', ['message_templates']);
  await page.goto(`/channels/${site.id}/sending`);
  const root = section(page);
  await expect(root.getByRole('heading', { name: 'System emails' })).toBeVisible();
  const row = root
    .getByRole('listitem')
    .filter({ hasText: /confirm/i })
    .first();
  await expect(row).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'system-emails-list');

  // Text in the standard design.
  await row.getByRole('button', { name: 'Edit' }).click();
  const editor = root.locator('div.mt-4', { has: page.getByLabel('Subject') });
  await editor.getByLabel('Subject').fill('Almost in: {{channel_name}}');
  await editor.getByLabel('Heading').fill('One more step');
  await editor.getByLabel('Message').fill('Press the button to start reading the notes.');
  await editor.getByLabel('Button text').fill('Yes, count me in');
  await editor.getByRole('button', { name: 'Preview' }).click();
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByText('One more step')).toBeVisible();
  await expect(preview.getByText('Yes, count me in')).toBeVisible();
  await expect(editor.getByText('Almost in: Field Notes')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'system-emails-preview');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved.');
  await expect(row.getByText('Your wording')).toBeVisible();

  // The test goes to the signed-in owner, with the wording on the screen.
  await editor.getByRole('button', { name: 'Send me a test' }).click();
  await expect(editor.getByRole('status')).toContainText(`Test sent to ${site.email}`);
  const sample = await latestMail(request, site.email, /Almost in/);
  expect(sample.subject).toContain('Almost in: Field Notes');
  expect(sample.html).toContain('Yes, count me in');

  // A real signup receives the edited email, and its button works.
  const reader = await browser.newContext();
  const visit = await reader.newPage();
  const email = `sysmail-reader-${Date.now()}@example.com`;
  await publishForm(page, site.id);
  await subscribeOnSite(visit, site.origin, email);
  const mail = await latestMail(request, email);
  expect(mail.subject).toBe('Almost in: Field Notes');
  expect(mail.html).toContain('One more step');
  expect(mail.html).toContain('Press the button to start reading the notes.');
  expect(mail.html).toContain('Yes, count me in');
  await visit.goto(await mailLink(request, email, '/v1/confirm/'));
  await visit.getByRole('button', { name: /confirm/i }).click();
  await expect
    .poll(async () => {
      const rows = await api<{ items: { email: string; status: string }[] }>(
        page,
        'GET',
        `/api/v1/channels/${site.id}/members`,
      );
      return rows.items.find((item) => item.email === email)?.status;
    })
    .toBe('active');
  await reader.close();

  // HTML: one without the link is refused, with the reason on the screen.
  await page.reload();
  await row.getByRole('button', { name: 'Edit' }).click();
  await editor.getByRole('radio', { name: 'My own HTML' }).check();
  const html = editor.getByRole('textbox', { name: 'HTML' });
  await expect(html).toBeVisible();
  await html.fill('<html><body><p>No link in this one.</p></body></html>');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('{{confirm_url}}');
  await shot(page, 'system-emails-refused-link');
  await html.fill('<p><a href="{{confirm_url}}">Go</a></p><script>alert(1)</script>');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText(/script/i);
  await expectAccessible(page);
  await shot(page, 'system-emails-refused-script');

  // The refused version changed nothing: the saved wording is still what goes out.
  await page.reload();
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor.getByLabel('Subject')).toHaveValue('Almost in: {{channel_name}}');
  await expect(editor.getByLabel('Message')).toHaveValue(
    'Press the button to start reading the notes.',
  );

  // Good HTML saves, previews and survives a reload.
  await editor.getByRole('radio', { name: 'My own HTML' }).check();
  await html.fill('<h1>Hand made</h1><p><a href="{{confirm_url}}">Confirm here</a></p>');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(preview.getByRole('heading', { name: 'Hand made' })).toBeVisible();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor.getByRole('radio', { name: 'My own HTML' })).toBeChecked();
  await expect(html).toHaveValue(/Hand made/);

  // Reset brings the built-in wording back.
  await editor.getByRole('button', { name: 'Reset to built-in' }).click();
  await expect(row.getByText('Your wording')).toHaveCount(0);
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor.getByRole('radio', { name: 'Text in the standard design' })).toBeChecked();
  await expect(editor.getByLabel('Subject')).not.toHaveValue(/Almost in/);
});
