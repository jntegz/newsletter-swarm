// The posts page: the archive and the calendar view, with past issues that must not look unsent.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, localSql, openMoreOptions } from './helpers';
import { api, publication, shot, type Publication } from './screens';

const FLAGS = ['post_archive', 'content_calendar', 'archive_import'];
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

interface Post {
  id: string;
  status: string;
  plannedDate: string | null;
  publishAt: string | null;
  archivedAt: string | null;
  slug: string | null;
}

const newPost = (page: Page, channel: Publication, subject: string) =>
  api<Post>(page, 'POST', `/api/v1/channels/${channel.id}/dispatches`, {
    subject,
    content: doc(`The body of ${subject}.`),
  });
const readPost = (page: Page, id: string) => api<Post>(page, 'GET', `/api/v1/dispatches/${id}`);
const plan = (page: Page, id: string, plannedDate: string) =>
  api(page, 'PUT', `/api/v1/dispatches/${id}/planned-date`, { plannedDate });

/** A day of next month, which is always in the future. Days 20 to 28 exist in every month. */
const nextMonth = (day: number) => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(day)}`;
};
const cell = (page: Page, day: string) => page.locator(`td[data-day="${day}"]`);
/** A status chip of the posts list; its name ends with its count. */
const chip = (page: Page, label: string) =>
  page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: new RegExp(`^${label}\\b`) });

async function openPosts(page: Page, channel: Publication) {
  await page.goto(`/dispatches?channel=${channel.id}`);
  await expect(page.getByRole('heading', { name: 'Posts', level: 1 })).toBeVisible();
}
async function openCalendar(page: Page, channel: Publication) {
  await openPosts(page, channel);
  await page.getByRole('group', { name: 'Show posts as' }).getByText('Calendar').click();
  await expect(page.locator('table.cal-grid')).toBeVisible();
}

test.describe('archive', () => {
  test('hides sent posts from the list, keeps them on the website, and restores them', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const channel = await publication(page, request, 'archive', FLAGS);
    const sent = await newPost(page, channel, 'Sent in spring');
    const second = await newPost(page, channel, 'Sent in summer');
    const scheduled = await newPost(page, channel, 'Going out soon');
    const draft = await newPost(page, channel, 'Still writing');
    await api(page, 'POST', `/api/v1/dispatches/${sent.id}/publish-web`);
    localSql(
      `UPDATE dispatches SET status = 'sent', sent_at = ${Date.now()} WHERE id IN ('${sent.id}', '${second.id}')`,
    );
    localSql(
      `UPDATE dispatches SET status = 'scheduled', publish_at = ${Date.now() + 86_400_000} WHERE id = '${scheduled.id}'`,
    );
    const { slug } = await readPost(page, sent.id);
    const onSite = async () => (await request.get(`${channel.origin}/p/${slug}`)).status();
    const before = await onSite();
    expect(before).toBe(200);

    await openPosts(page, channel);
    await expect(page.getByRole('row', { name: /Going out soon/ })).toContainText(
      'Can’t archive until it’s sent',
    );
    await expect(page.getByRole('button', { name: 'Archive Going out soon' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive Still writing' })).toHaveCount(0);
    await shot(page, 'archive-list');

    await page.getByRole('button', { name: 'Archive Sent in spring' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Archived 1 post' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sent in spring' })).toHaveCount(0);
    expect(await onSite()).toBe(200);
    expect((await readPost(page, sent.id)).status).toBe('sent');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name: 'Sent in spring' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Select Sent in spring' }).check();
    await page.getByRole('checkbox', { name: 'Select Sent in summer' }).check();
    // What archiving doesn't do is said next to the button that does it.
    await expect(page.getByText('stays on your website')).toBeVisible();
    await page.getByRole('button', { name: 'Archive 2 posts' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Archived 2 posts' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sent in summer' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Still writing' })).toBeVisible();

    await chip(page, 'Archived').click();
    await expect(page.getByRole('link', { name: 'Sent in spring' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Still writing' })).toHaveCount(0);
    await shot(page, 'archive-shelf');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Restore Sent in spring' }).click();
    await expect(page.getByRole('link', { name: 'Sent in spring' })).toHaveCount(0);
    await chip(page, 'All').click();
    await expect(page.getByRole('link', { name: 'Sent in spring' })).toBeVisible();
    await expect((await readPost(page, draft.id)).status).toBe('draft');
  });

  test('the switches hide both features and the server refuses them', async ({ page, request }) => {
    const channel = await publication(page, request, 'noswitch', []);
    await newPost(page, channel, 'A plain post');
    await openPosts(page, channel);
    await expect(page.getByRole('link', { name: 'A plain post' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Show posts as' })).toHaveCount(0);
    await expect(chip(page, 'Archived')).toHaveCount(0);
    const refused = await page.request.get(
      `/api/v1/channels/${channel.id}/dispatches/calendar?from=2026-11-01&to=2026-11-30`,
    );
    expect(refused.status()).toBe(404);
  });
});

test.describe('calendar', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test('plans drafts by drag and by keyboard, and moves a send only on purpose', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const channel = await publication(page, request, 'calendar', FLAGS);
    await api(page, 'POST', `/api/v1/channels/${channel.id}/members`, {
      email: `reader-${Date.now()}@example.com`,
      consent: true,
    });
    const draft = await newPost(page, channel, 'Autumn plans');
    await plan(page, draft.id, nextMonth(21));

    // 23:30 UTC is the next morning in Tokyo, so the post sits on the later day.
    const scheduled = await newPost(page, channel, 'Going out on time');
    const sendsAt = new Date(`${nextMonth(23)}T23:30:00.000Z`);
    await api(page, 'POST', `/api/v1/dispatches/${scheduled.id}/schedule`, {
      publishAt: sendsAt.toISOString(),
    });
    const sent = await newPost(page, channel, 'Already out');
    localSql(
      `UPDATE dispatches SET status = 'sent', sent_at = ${Date.parse(`${nextMonth(20)}T03:00:00.000Z`)} WHERE id = '${sent.id}'`,
    );

    await openCalendar(page, channel);
    await expect(page.getByText('Times are in Asia/Tokyo')).toBeVisible();
    await expect(page.getByText('doesn’t schedule or send anything')).toBeVisible();
    await expect(page.locator('td[aria-current="date"]')).toContainText('Today');

    // Previous, next and today.
    const heading = page.getByRole('heading', { level: 2 }).first();
    const current = await heading.innerText();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(heading).not.toHaveText(current);
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(heading).toHaveText(current);
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(heading).not.toHaveText(current);

    await expect(cell(page, nextMonth(21))).toContainText('Autumn plans');
    await expect(cell(page, nextMonth(21))).toContainText('Draft, planned');
    await expect(cell(page, nextMonth(24))).toContainText('Going out on time');
    await expect(cell(page, nextMonth(24))).toContainText('Scheduled, 08:30');
    await expect(cell(page, nextMonth(23))).not.toContainText('Going out on time');
    await expect(cell(page, nextMonth(20))).toContainText('Sent, 12:00');
    await shot(page, 'calendar-month');
    await expectAccessible(page);

    // The choice is remembered.
    await page.reload();
    await expect(page.locator('table.cal-grid')).toBeVisible();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(cell(page, nextMonth(21))).toContainText('Autumn plans');

    // Dragging a draft moves its planned date, and nothing else.
    await page
      .locator('li[data-kind="draft"]')
      .filter({ hasText: 'Autumn plans' })
      .first()
      .dragTo(cell(page, nextMonth(25)));
    await expect(cell(page, nextMonth(25))).toContainText('Autumn plans');
    await expect.poll(async () => (await readPost(page, draft.id)).plannedDate).toBe(nextMonth(25));
    const moved = await readPost(page, draft.id);
    expect(moved).toMatchObject({ status: 'draft', publishAt: null });

    // Dragging a scheduled post does nothing at all.
    const scheduledEntry = page
      .locator('li[data-kind="scheduled"]')
      .filter({ hasText: 'Going out on time' })
      .first();
    await expect(scheduledEntry).not.toHaveAttribute('draggable', 'true');
    await scheduledEntry.dragTo(cell(page, nextMonth(26)), { force: true });
    await expect(cell(page, nextMonth(26))).not.toContainText('Going out on time');
    expect((await readPost(page, scheduled.id)).publishAt).toBe(sendsAt.toISOString());

    // The keyboard way to move a draft.
    const move = page.getByRole('button', { name: 'Move Autumn plans to another day' }).first();
    await move.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Change planned date' });
    await expect(dialog).toContainText('doesn’t schedule or send anything');
    await shot(page, 'calendar-plan-dialog');
    await dialog.getByLabel('Planned date').fill(nextMonth(27));
    await dialog.getByRole('button', { name: 'Save date' }).click();
    await expect(cell(page, nextMonth(27))).toContainText('Autumn plans');
    await expect.poll(async () => (await readPost(page, draft.id)).plannedDate).toBe(nextMonth(27));

    // A send moves through the explicit control, with the scheduling route's checks.
    await page.getByRole('button', { name: 'Change time of Going out on time' }).first().click();
    const sendDialog = page.getByRole('dialog', { name: 'Change send time' });
    await expect(sendDialog).toContainText('pre-send checks run again');
    await shot(page, 'calendar-send-dialog');
    await sendDialog.getByLabel('Send at').fill('2020-01-01T09:00');
    await sendDialog.getByRole('button', { name: 'Change send time' }).click();
    await expect(sendDialog).toContainText('at least a minute from now');
    expect((await readPost(page, scheduled.id)).publishAt).toBe(sendsAt.toISOString());
    await sendDialog.getByLabel('Send at').fill(`${nextMonth(28)}T09:15`);
    await sendDialog.getByRole('button', { name: 'Change send time' }).click();
    await expect(cell(page, nextMonth(28))).toContainText('Scheduled, 09:15');
    expect((await readPost(page, scheduled.id)).publishAt).toBe(
      new Date(`${nextMonth(28)}T00:15:00.000Z`).toISOString(),
    );

    // An entry opens its post.
    await page.getByRole('link', { name: 'Already out' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/dispatches/${sent.id}`));
  });

  test('an empty day starts a post with that planned date', async ({ page, request }) => {
    test.setTimeout(120_000);
    const channel = await publication(page, request, 'calnew', FLAGS);
    await openCalendar(page, channel);
    await page.getByRole('button', { name: 'Next month' }).click();
    const next = new Date();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const day = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-15`;
    const target = cell(page, day);
    await target.hover();
    await target.getByRole('button', { name: /New post for/ }).click();
    await expect(page).toHaveURL(/\/dispatches\/dsp_|\/dispatches\/[a-z]/);
    await openMoreOptions(page);
    await expect(page.getByLabel('Planned date')).toHaveValue(day);
    await expect(page.getByText('It doesn’t schedule or send anything.')).toBeVisible();
    await shot(page, 'editor-planned-date');
  });

  test('a phone gets an agenda list', async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 800 });
    const channel = await publication(page, request, 'calphone', FLAGS);
    const draft = await newPost(page, channel, 'Phone plans');
    await plan(page, draft.id, nextMonth(22));
    await page.goto(`/dispatches?channel=${channel.id}`);
    await page.getByRole('group', { name: 'Show posts as' }).getByText('Calendar').click();
    await expect(page.locator('table.cal-grid')).toBeHidden();
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(
      page.getByRole('link', { name: 'Phone plans' }).locator('visible=true'),
    ).toBeVisible();
    await expect(page.getByText('Draft, planned').locator('visible=true')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New post', exact: true }).last()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'calendar-phone');
    await page.getByRole('button', { name: 'Move Phone plans to another day' }).click();
    await page.getByRole('dialog').getByLabel('Planned date').fill(nextMonth(26));
    await page.getByRole('dialog').getByRole('button', { name: 'Save date' }).click();
    await expect.poll(async () => (await readPost(page, draft.id)).plannedDate).toBe(nextMonth(26));
    await expectAccessible(page);
  });
});

test('a past issue looks like one, on every screen, and offers no way to send', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const channel = await publication(page, request, 'pastissue', FLAGS);
  const when = new Date(Date.now() - 2 * 86_400_000);
  const result = await api<{ results: { outcome: string }[] }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/archive-import`,
    {
      dryRun: false,
      items: [
        {
          subject: 'The old issue',
          preheader: '',
          slug: 'the-old-issue',
          publishedAt: when.toISOString(),
          visibility: 'public',
          content: doc('From the old days.'),
        },
      ],
    },
  );
  expect(result.results[0]!.outcome).toBe('imported');

  await openPosts(page, channel);
  const row = page.getByRole('row', { name: /The old issue/ });
  await expect(row).toContainText('Past issue');
  await expect(row).not.toContainText('Draft');
  await expect(row).toContainText('On your website since');
  await shot(page, 'past-issue-list');

  await page.goto(`/?channel=${channel.id}`);
  await expect(page.getByRole('heading', { name: /Up next/ })).toBeVisible();
  // "Duplicate" in the closed New post menu may name it; nothing on the page offers to send it.
  await expect(page.getByText('The old issue').locator('visible=true')).toHaveCount(0);

  await page.goto(`/dispatches?channel=${channel.id}`);
  await row.getByRole('link', { name: 'The old issue' }).click();
  const settings = page.getByRole('complementary', { name: 'Post settings' });
  await expect(settings.getByRole('heading', { name: 'Past issue' })).toBeVisible();
  await expect(settings).toContainText('Swarm won’t email it');
  await expect(settings.getByRole('button', { name: /^Send|Schedule/ })).toHaveCount(0);
  await expect(page.getByText('Check & send')).toHaveCount(0);
  await shot(page, 'past-issue-editor');

  await page.goto(`/dispatches?channel=${channel.id}`);
  await page.getByRole('group', { name: 'Show posts as' }).getByText('Calendar').click();
  const day = page.locator('li[data-kind="past"]').filter({ hasText: 'The old issue' });
  if (when.getMonth() !== new Date().getMonth()) {
    await page.getByRole('button', { name: 'Previous month' }).click();
  }
  await expect(day.first()).toContainText('Past issue');
  await expect(day.first()).not.toHaveAttribute('draggable', 'true');
  await expect(day.getByRole('button')).toHaveCount(0);
});
