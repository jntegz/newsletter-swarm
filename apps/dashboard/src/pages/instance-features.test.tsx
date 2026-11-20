import type { InstanceFeature, Me } from '@swarm/domain';
import {
  FEATURES_OFF_AT_INSTALL,
  FEATURES_WITHOUT_A_GATE,
  FLAG_KEYS,
  SWITCHABLE_FLAG_KEYS,
} from '@swarm/flags/registry';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceKeys, saveInstanceFeatureOptions } from '../api/instance';
import { FeatureSwitchView } from './InstanceFeatures';
import {
  arrangeFeatures,
  COPILOT_NOTE,
  FEATURE_GROUPS,
  FEATURE_SAVED,
  FEATURE_SAVING,
  featureSaveError,
  FEATURES_INTRO,
  NO_SWITCH,
} from './instance-features';
import { InstanceSettingsPage } from './InstanceSettings';

const session = vi.hoisted(() => ({ instanceAdmin: true }));
vi.mock('../session', () => ({
  useSession: () => ({ me: { instanceAdmin: session.instanceAdmin } as Me }),
}));

const feature = (key: string, enabled = true): InstanceFeature => ({
  key,
  enabled,
  updatedBy: null,
  updatedAt: null,
});
const everyFeature = () =>
  SWITCHABLE_FLAG_KEYS.map((key) => feature(key, !FEATURES_OFF_AT_INSTALL.includes(key)));
const copy = FEATURE_GROUPS.flatMap((group) => group.features);

describe('the words for each feature', () => {
  it('covers every switchable feature, or says why it has no switch', () => {
    const covered = [...copy.map((f) => f.key), ...NO_SWITCH].sort();
    expect(covered).toEqual([...SWITCHABLE_FLAG_KEYS].sort());
  });

  it('has no words for anything else, and lists each feature once', () => {
    const keys = copy.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(FLAG_KEYS).toContain(key);
  });

  it('hides exactly the flags nothing checks', () => {
    expect([...NO_SWITCH]).toEqual([...FEATURES_WITHOUT_A_GATE]);
  });

  it('uses plain words: no internal names, sentence case, a full stop on the help', () => {
    const internal =
      /\b(dispatch|circle|member|broadcast|channel|gate|gated|flow|champion|capture|preheader)s?\b/i;
    const lines = [
      FEATURES_INTRO,
      COPILOT_NOTE,
      FEATURE_SAVED,
      ...FEATURE_GROUPS.map((g) => g.title),
      ...copy.flatMap((f) => [f.label, f.help]),
    ];
    for (const line of lines) expect(line).not.toMatch(internal);
    for (const f of copy) {
      expect(f.help, f.key).toMatch(/\.$/);
      expect(f.label.slice(1), f.key).not.toMatch(/ [A-Z][a-z]/);
      expect(f.help, f.key).not.toContain('!');
    }
  });
});

describe('arrangeFeatures', () => {
  it('sorts the list into the groups with its values, and hides what has no switch', () => {
    const groups = arrangeFeatures(everyFeature());
    expect(groups.map((g) => g.title)).toEqual(FEATURE_GROUPS.map((g) => g.title));
    const rows = groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(copy.length);
    expect(rows.find((r) => r.key === 'split_tests')?.enabled).toBe(true);
    expect(rows.find((r) => r.key === 'copilot')?.enabled).toBe(false);
    expect(rows.map((r) => r.key)).not.toContain('nojs_subscribe');
  });

  it('drops a group with nothing in it', () => {
    expect(arrangeFeatures([feature('copilot', false)])).toEqual([
      {
        title: 'Copilot',
        note: COPILOT_NOTE,
        rows: [expect.objectContaining({ key: 'copilot', enabled: false })],
      },
    ]);
  });

  it('still offers a switch for a key with no words yet', () => {
    expect(arrangeFeatures([feature('something_new')])).toEqual([
      {
        title: 'Other',
        rows: [{ key: 'something_new', label: 'something_new', help: '', enabled: true }],
      },
    ]);
  });
});

describe('one switch', () => {
  const row = { key: 'split_tests', label: 'Split tests', help: 'Try things.', enabled: true };
  const render = (props: Partial<Parameters<typeof FeatureSwitchView>[0]>) =>
    renderToStaticMarkup(<FeatureSwitchView row={row} onChange={() => {}} {...props} />);

  it('shows the saved state', () => {
    const html = render({});
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Split tests');
    expect(html).toContain('Try things.');
    expect(html).not.toContain(FEATURE_SAVED);
  });

  it('while saving: shows where it is going, is busy, and says so', () => {
    const html = render({ saving: false });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(FEATURE_SAVING);
  });

  it('when saved: says so, with the delay', () => {
    const html = render({ saved: true });
    expect(html).toContain('Saved.');
    expect(html).toContain('up to a minute');
  });

  it('when a save fails: goes back, and says what happened', () => {
    const html = render({ error: 'Swarm could not be reached.' });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Not saved, so this is still on. Swarm could not be reached.');
    expect(featureSaveError(false, 'x')).toBe('Not saved, so this is still off. x');
  });
});

describe('Settings → Instance', () => {
  const page = () => {
    const client = new QueryClient();
    client.setQueryData(instanceKeys.settings, { signup: 'invite_only' });
    client.setQueryData(instanceKeys.features, everyFeature());
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <InstanceSettingsPage />
      </QueryClientProvider>,
    );
  };

  beforeEach(() => {
    session.instanceAdmin = true;
  });

  it('shows an admin grouped switches, the delay and the paid service', () => {
    const html = page();
    expect(html).toContain('Who can sign up');
    expect(html).toContain('>Features</h2>');
    for (const group of FEATURE_GROUPS) expect(html).toContain(`>${group.title}</h3>`);
    expect(html.match(/role="switch"/g)).toHaveLength(copy.length);
    expect(html).toContain('up to a minute');
    expect(html).toContain('up to six minutes on website pages');
    expect(html).toContain('Copilot uses a paid AI service');
    expect(html).not.toContain('nojs_subscribe');
  });

  it('shows Copilot and single sign-on off and the others on, as stored', () => {
    const html = page();
    const off = FEATURES_OFF_AT_INSTALL.length;
    expect(html.match(/aria-checked="false"/g)).toHaveLength(off);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(copy.length - off);
  });

  it('shows a non-admin none of it', () => {
    session.instanceAdmin = false;
    const html = page();
    expect(html).toContain('Only the owner of this Swarm');
    expect(html).not.toContain('Features');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('Copilot');
  });
});

describe('saving a feature', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  const setup = () => {
    const client = new QueryClient();
    client.setQueryData(instanceKeys.features, [
      feature('split_tests', true),
      feature('pledges', true),
    ]);
    const observer = new MutationObserver(client, saveInstanceFeatureOptions(client));
    return { client, observer };
  };

  it('sends one PUT, and only that feature changes in the list', async () => {
    const saved = { ...feature('split_tests', false), updatedAt: '2026-11-02T00:00:00.000Z' };
    const fetch = respond(200, { data: saved });
    vi.stubGlobal('fetch', fetch);
    const { client, observer } = setup();

    await observer.mutate({ key: 'split_tests', enabled: false });

    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/instance/features/split_tests');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ enabled: false }));
    expect(client.getQueryData(instanceKeys.features)).toEqual([saved, feature('pledges', true)]);
  });

  it('leaves the list as it was when the save fails', async () => {
    vi.stubGlobal(
      'fetch',
      respond(403, { error: { code: 'forbidden', message: 'Only the owner.' } }),
    );
    const { client, observer } = setup();

    await expect(observer.mutate({ key: 'split_tests', enabled: false })).rejects.toThrow(
      'Only the owner.',
    );
    expect(client.getQueryData(instanceKeys.features)).toEqual([
      feature('split_tests', true),
      feature('pledges', true),
    ]);
  });
});
