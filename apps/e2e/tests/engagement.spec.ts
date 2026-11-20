import { expect, test } from '@playwright/test';
import {
  createPublication,
  enableWorkspaceFlag,
  localSql,
  signIn,
  turnOnTracking,
} from './helpers';

test('a writer sees who is reading, and someone behind a privacy proxy isn’t called cold', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `engage-${stamp}@example.com`);
  const session = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data;
  });
  enableWorkspaceFlag('engagement_scores', session.workspaces[0]!.id);
  await createPublication(page, 'Field Notes', `engage-${stamp}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  // Engagement scores come from reader profiles, which a new publication starts without.
  await turnOnTracking(page, channelId, ['trackOpens', 'profileReaders']);

  const add = async (email: string) => {
    const { status, body } = await page.evaluate(
      async ({ path, email }) => {
        const res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ email, consent: true }),
        });
        return { status: res.status, body: await res.text() };
      },
      { path: `/api/v1/channels/${channelId}/members`, email },
    );
    expect(status, body).toBe(201);
    return (JSON.parse(body) as { data: { id: string } }).data.id;
  };
  const score = (id: string, value: number | null, band: string) =>
    localSql(
      `INSERT INTO member_engagement (member_id, channel_id, score, band, sent_count, opened_count, clicked_count, computed_at)
       VALUES ('${id}', '${channelId}', ${value ?? 'NULL'}, '${band}', 4, 0, 0, ${Date.now()})`,
    );
  const cold = `cold-${stamp}@example.com`;
  const hidden = `hidden-${stamp}@example.com`;
  score(await add(cold), 4, 'cold');
  score(await add(hidden), null, 'opens_hidden');

  await page.goto(`/members?channel=${channelId}`);
  await page.getByRole('button', { name: /columns/i }).click();
  await page.getByRole('checkbox', { name: 'Engagement' }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: new RegExp(cold) })).toContainText('Cold (4)');
  await expect(page.getByRole('row', { name: new RegExp(hidden) })).toContainText('Opens hidden');

  await page.getByRole('button', { name: hidden }).click();
  await expect(page.getByRole('dialog').getByText('privacy service')).toBeVisible();
});
