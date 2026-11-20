// Website settings through their real screens: the cookie popup and site code, Branding (custom CSS;
// the design itself is in Website → Design, see site-design.spec.ts), and what a save keeps.
// cookies-and-code.spec.ts covers the reader side of the popup.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, publication, shot } from './screens';

interface Settings {
  theme: Record<string, unknown>;
  customCss: string;
  consent: { enabled: boolean; text: string };
  code: { name: string; value: string; category: string }[];
}

const settings = (page: Page, id: string) =>
  api<Settings>(page, 'GET', `/api/v1/channels/${id}/site/settings`);

const tab = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Website sections' })
    .getByRole('link', { name, exact: true });

test('Cookies and code: popup on, a tool by id, a wrong id refused, the warning without a popup', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'cookieui', ['site_custom_code']);
  await page.goto(`/site/${site.id}`);
  await tab(page, 'Cookies and code').click();
  const form = page.getByRole('form', { name: 'Cookies and code' });
  await expect(form.getByRole('heading', { name: 'Cookie popup' })).toBeVisible();
  await expectAccessible(page);

  // Code that needs agreement, with no popup: the screen says it won't run.
  await form.getByRole('button', { name: 'Add a tool' }).click();
  await expect(form.getByText(/Turn on the cookie popup/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'cookies-warning');

  // A wrong id is refused, and the reason is on the screen.
  await form.getByLabel('Measurement ID, like G-ABC123DEF4').fill('UA-12345');
  await form.getByRole('button', { name: /^Save/ }).click();
  await expect(form.getByText(/^Google Analytics: /)).toBeVisible();
  await shot(page, 'cookies-wrong-id');
  expect((await settings(page, site.id)).code).toEqual([]);

  // Turning the popup on takes the warning away and saves through the screen.
  await form.getByLabel('Measurement ID, like G-ABC123DEF4').fill('G-ABC123DEF4');
  await form.getByLabel('Show a cookie popup on my website').check();
  await expect(form.getByText(/Turn on the cookie popup/)).toHaveCount(0);
  await form.getByLabel('Message').fill('We count visits, with your agreement.');
  await form.getByLabel('Accept button').fill('Fine by me');
  await form.getByLabel('Reject button').fill('No thanks');
  await expectAccessible(page);
  await form.getByRole('button', { name: /^Save/ }).click();
  await expect(form.getByText(/^Saved/)).toBeVisible();
  await shot(page, 'cookies-saved');

  // It survives a reload.
  await page.reload();
  await expect(form.getByLabel('Show a cookie popup on my website')).toBeChecked();
  await expect(form.getByLabel('Measurement ID, like G-ABC123DEF4')).toHaveValue('G-ABC123DEF4');
  await expect(form.getByLabel('Message')).toHaveValue('We count visits, with your agreement.');

  // A reader sees it. Nothing loads from the tool until they agree.
  const reader = await browser.newContext();
  const asked: string[] = [];
  await reader.route('https://www.googletagmanager.com/**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  const visit = await reader.newPage();
  await visit.goto(`${site.origin}/`);
  await expect(visit.getByRole('button', { name: 'Fine by me' })).toBeVisible();
  await expect(visit.getByRole('button', { name: 'No thanks' })).toBeVisible();
  await shot(visit, 'cookies-popup-on-site');
  expect(asked).toEqual([]);
  await visit.getByRole('button', { name: 'Fine by me' }).click();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[0]).toContain('G-ABC123DEF4');
  await reader.close();

  // A policy link that isn't a path or https is refused beside the field.
  await form.getByLabel('Cookie policy link').fill('http://example.com/cookies');
  await form.getByRole('button', { name: /^Save/ }).click();
  await expect(form.getByText('Use a path on your site or an https address.')).toBeVisible();
});

test('Cookies and code on a shared install: why code does not run, and a tracking tool marked necessary', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'codeplace', ['site_custom_code'], false);
  await page.goto(`/site/${site.id}`);
  await tab(page, 'Cookies and code').click();
  const form = page.getByRole('form', { name: 'Cookies and code' });
  await expect(form.getByText(/Code runs only on your own domain/)).toBeVisible();
  await expect(form.getByRole('link', { name: 'add your own domain' })).toBeVisible();

  // A new script on this Swarm's own domain is refused, and the reason is on the screen.
  await form.getByRole('button', { name: 'Add a tool' }).click();
  await form.getByLabel('Measurement ID, like G-ABC123DEF4').fill('G-ABC123DEF4');
  await form.getByLabel('Show a cookie popup on my website').check();
  await form.getByRole('button', { name: /^Save/ }).click();
  await expect(form.getByText(/Code can run only on your own domain/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'cookies-code-not-allowed');
  expect((await settings(page, site.id)).code).toEqual([]);

  // Marking a tracking tool strictly necessary asks for a confirmation, and moves nothing.
  await form.getByLabel('When it runs').selectOption('necessary');
  const confirm = form.getByLabel('It is strictly necessary for my site to work');
  await expect(form.getByText(/This looks like Google Analytics/)).toBeVisible();
  await expect(confirm).not.toBeChecked();
  await expect(form.getByLabel('When it runs')).toHaveValue('necessary');
  await expectAccessible(page);
  await shot(page, 'cookies-necessary-tracker');
  // Choosing Analytics again takes the question away.
  await form.getByLabel('When it runs').selectOption('analytics');
  await expect(confirm).toHaveCount(0);
});

test('Branding with templates: the design is in Design, custom CSS on the site, bad CSS refused, a save keeps fields', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'tplui', ['site_templates']);
  // A template chosen before the design studio existed: its words stay with the site.
  await api(page, 'PATCH', `/api/v1/channels/${site.id}/site/settings`, {
    theme: {
      template: 'magazine',
      headline: 'The long view',
      pitch: 'Weekly notes from the hill.',
    },
  });
  await page.goto(`/site/${site.id}`);
  await tab(page, 'Branding').click();
  const form = page.getByRole('form', { name: 'Branding' });
  // Template, wording, colours and fonts moved to Design; Branding points there.
  await expect(form.getByRole('link', { name: 'Open Design' })).toBeVisible();
  await expect(form.getByRole('group', { name: 'Template' })).toHaveCount(0);
  await expect(form.getByLabel('Headline')).toHaveCount(0);
  await expect(form.getByRole('group', { name: 'Font', exact: true })).toHaveCount(0);
  await expect(form.getByRole('group', { name: 'Colour scheme' })).toHaveCount(0);
  await expect(form.getByText(/Added after the theme.s CSS/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'branding-template');

  // Save is in the Unsaved changes bar, which shows once something changes.
  const save = form.getByRole('button', { name: 'Save', exact: true });
  const saved = form.getByRole('status').filter({ hasText: /^Saved$/ });
  await expect(save).toHaveCount(0);

  // A save keeps everything the design took over, as it was.
  await form.getByLabel('Drop caps').check();
  await save.click();
  await expect(saved).toBeAttached();
  await expect(save).toHaveCount(0);
  const first = await settings(page, site.id);
  expect(first.theme).toMatchObject({
    template: 'magazine',
    headline: 'The long view',
    pitch: 'Weekly notes from the hill.',
    dropCaps: true,
  });

  // Bad CSS is refused beside the field, and nothing is stored.
  const css = form.getByRole('textbox', { name: 'Custom CSS' });
  await css.fill('@import url("https://evil.example.com/x.css");');
  await save.click();
  await expect(form.getByText(/@import isn.t allowed/).first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'branding-bad-css');
  expect((await settings(page, site.id)).customCss).toBe('');

  // Good CSS reaches the site, and nothing else in the theme changed.
  await css.fill('.sw-footer { outline: 3px solid rgb(1, 2, 3); }');
  await save.click();
  await expect(saved).toBeAttached();
  expect((await settings(page, site.id)).theme).toEqual(first.theme);
  const visit = await page.context().newPage();
  await visit.goto(`${site.origin}/`);
  await expect(visit.getByRole('heading', { name: 'The long view' })).toBeVisible();
  await expect(visit.locator('.sw-footer')).toHaveCSS('outline-color', 'rgb(1, 2, 3)');
  await shot(visit, 'branding-on-site');
  await visit.close();

  // Open Design goes to the studio.
  await form.getByRole('link', { name: 'Open Design' }).click();
  await expect(page).toHaveURL(new RegExp(`/site/${site.id}/design`));
  await expect(page.getByRole('tab', { name: 'Template' })).toBeVisible();
});

test('Branding without templates: font and colour scheme stay, and a save keeps the rest', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const site = await publication(page, request, 'brandui', []);
  await page.goto(`/site/${site.id}`);
  await expect(tab(page, 'Design')).toHaveCount(0);
  await tab(page, 'Branding').click();
  const form = page.getByRole('form', { name: 'Branding' });
  await expect(form.getByRole('link', { name: 'Open Design' })).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: 'Custom CSS' })).toHaveCount(0);
  await expectAccessible(page);

  // A first save with Geist, the default: no font is stored, so the default can change later.
  const save = form.getByRole('button', { name: 'Save', exact: true });
  const saved = form.getByRole('status').filter({ hasText: /^Saved$/ });
  await form.getByLabel('Drop caps').check();
  await save.click();
  await expect(saved).toBeAttached();
  expect((await settings(page, site.id)).theme.font).toBeUndefined();

  await form.getByRole('radio', { name: /^Inter/ }).check();
  await form.getByRole('radio', { name: /^Dark/ }).check();
  await save.click();
  await expect(saved).toBeAttached();
  expect((await settings(page, site.id)).theme).toMatchObject({
    font: 'inter',
    colorScheme: 'dark',
    dropCaps: true,
  });
  await page.reload();
  await expect(form.getByRole('radio', { name: /^Inter/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  await shot(page, 'branding-plain');
});

test('Signup settings: the steps choice and every subscriber must confirm save and reload', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const site = await publication(page, request, 'signupui', ['signup_paths']);
  await page.goto(`/channels/${site.id}`);
  const must = page.getByLabel('Every subscriber must confirm');
  const doubleOptIn = page.getByLabel('Double opt-in');
  await expect(doubleOptIn).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'channel-signup');

  // It depends on Double opt-in, and shows that.
  if (await doubleOptIn.isChecked()) await doubleOptIn.uncheck();
  await expect(must).toBeDisabled();
  await expect(must).not.toBeChecked();
  await doubleOptIn.check();
  await expect(must).toBeEnabled();
  await must.check();
  const choices = page.getByRole('group', { name: 'Website signup' });
  await expect(choices).toBeVisible();
  const steps = choices.getByRole('radio');
  await steps.nth(1).check();
  const picked = await steps.nth(1).getAttribute('value');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect
    .poll(async () => {
      const channel = await api<{ requireConfirmation: boolean; signupPath: string }>(
        page,
        'GET',
        `/api/v1/channels/${site.id}`,
      );
      return `${channel.requireConfirmation} ${channel.signupPath}`;
    })
    .toBe(`true ${picked}`);
  await page.reload();
  await expect(must).toBeChecked();
  await expect(page.locator(`#signup-path-${picked}`)).toBeChecked();
});
