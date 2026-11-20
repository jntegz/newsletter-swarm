// The Capture Form builder in the dashboard: create a form, pick a placement and a trigger, try
// the trigger in the simulator, publish, copy the embed code, and check that the no-JS snippet
// is a working plain form. The embed itself is covered in capture.spec.ts.
import { expect, test } from '@playwright/test';
import { createPublication, expectAccessible, openSection, signIn } from './helpers';

const HOST = 'http://localhost:4597';

test('an operator builds a capture form, publishes it and copies the embed code', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/');
  await signIn(page, request, `forms-${stamp}@example.com`);
  await createPublication(page, 'Field Notes', `forms-${stamp.toString(36)}`);

  // The Channel default that the builder will show
  await expect(page.getByLabel('Double opt-in')).toBeChecked();

  // Empty list, then create
  await openSection(page, 'Signup forms');
  await expect(page.getByRole('heading', { name: 'No signup forms yet' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create a signup form' }).click();
  const create = page.getByRole('dialog', { name: 'Create a signup form' });
  await create.getByLabel('Name').fill('Essay popup');
  await create.getByRole('button', { name: 'Create form' }).click();
  await expect(page).toHaveURL(/\/forms\/cf_[0-9a-f]{32}$/);
  await expect(page.getByLabel('Form name')).toHaveValue('Essay popup');

  // Placement and trigger
  await page.getByRole('radio', { name: /^Popup/ }).check();
  await page.getByLabel('Trigger').selectOption({ label: 'After scrolling part of the page' });
  await page.getByLabel('Share of the page scrolled, in %').fill('60');
  await expect(
    page.getByRole('radio', { name: /^Publication default \(currently on\)/ }),
  ).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({
    timeout: 15_000,
  });

  // The simulator shows the popup only once the reader has scrolled far enough.
  const preview = page.frameLocator('iframe[title="Preview of the signup form on a sample page"]');
  await expect(preview.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Scroll to 30%' }).click();
  await expect(page.getByText('Waiting: shows after scrolling 60% of the page.')).toBeVisible();
  await page.getByRole('button', { name: 'Scroll to 60%' }).click();
  await expect(page.getByText('The form is showing.')).toBeVisible();
  await expect(preview.getByRole('dialog', { name: 'Join the list' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit the form' }).click();
  await expect(preview.getByText('Check your inbox to confirm.')).toBeVisible();
  await expectAccessible(page);
  // The preview's frame runs no scripts, so axe audits the same document on a page of its own.
  const previewHtml = await page
    .getByTitle('Preview of the signup form on a sample page')
    .getAttribute('srcdoc');
  const previewPage = await page.context().newPage();
  await previewPage.setContent(previewHtml!);
  await expectAccessible(previewPage);
  await previewPage.close();

  // The success message is limited to 80 characters, and an invalid draft is not saved.
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('x'.repeat(81));
  await expect(page.getByText('Keep the message to 80 characters.')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Not saved: fix the highlighted settings' }),
  ).toBeVisible({ timeout: 15_000 });
  await message.fill('Thanks. Check your inbox to confirm.');
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({
    timeout: 15_000,
  });

  // Publish
  await page.getByRole('button', { name: 'Publish', exact: true }).first().click();
  const publish = page.getByRole('dialog', { name: 'Publish this form?' });
  await expect(publish.getByText('Popup, regular layout')).toBeVisible();
  await expectAccessible(page);
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Version 1 is published.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Embed' })).toHaveAttribute('aria-selected', 'true');

  // Copy the embed code: a script tag pinned to version 1 with an SRI hash.
  await page.getByRole('button', { name: 'Copy embed code' }).click();
  await expect(page.getByText('Copied.')).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^<script async src="http:\/\/localhost:\d+\/v1\/cf_[0-9a-f]{32}\.js\?v=1" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"><\/script>$/,
  );
  await expectAccessible(page);

  // The no-JS snippet is a plain POST form with the email field and the honeypot.
  const noscript = await page
    .getByRole('region', { name: 'Form without JavaScript' })
    .locator('pre')
    .innerText();
  expect(noscript).toMatch(
    /^<form action="http:\/\/localhost:\d+\/v1\/cf_[0-9a-f]{32}\/subscribe" method="post">/,
  );
  expect(noscript).toContain('<input type="email" name="email" autocomplete="email" required');
  expect(noscript).toContain('name="website"');
  expect(noscript).toContain('<button type="submit">Join</button>');

  // With JavaScript off, the snippet still reaches the capture worker (which asks for a check).
  const off = await browser.newContext({ javaScriptEnabled: false });
  const plain = await off.newPage();
  await plain.route(`${HOST}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><main>${noscript}</main></body></html>`,
    }),
  );
  await plain.goto(`${HOST}/plain`);
  await plain.getByLabel('Email').fill(`nojs-${stamp}@example.org`);
  await plain.getByRole('button', { name: 'Join' }).click();
  await expect(plain.getByRole('heading', { name: 'One more step' })).toBeVisible();
  await off.close();

  // Version history names the publisher.
  await page.getByRole('button', { name: 'Version history' }).click();
  const history = page.getByRole('dialog', { name: 'Version history' });
  await expect(history.getByText(/^Version 1/)).toBeVisible();
  await expect(history.getByText('Live', { exact: true })).toBeVisible();
  await expect(history.getByText(/· You ·/)).toBeVisible();
  await history.getByRole('button', { name: 'Close' }).click();

  // The list shows the published form.
  await page.getByRole('link', { name: '← Signup forms' }).click();
  const row = page.getByRole('row', { name: /Essay popup/ });
  await expect(row.getByText('Published', { exact: true })).toBeVisible();
  await expect(row.getByText('v1', { exact: true })).toBeVisible();
});
