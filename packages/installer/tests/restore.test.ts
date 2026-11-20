import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { restoreKit } from '../src/commands/restore';
import { sealKit } from '../src/kit';
import { emptySecrets, emptyState, MemoryStateStore } from '../src/state';
import { fakeRun } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'swarm-kit-'));
const file = (name: string, content: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};
const state = { ...emptyState('production'), zone: { id: 'z1', name: 'example.com' } };
const secrets = { ...emptySecrets(), keys: { FIELD_KEYS: 'k1:test-only' } };

describe('restoring a recovery kit', () => {
  it('puts the state and keys back, so the other commands work again', async () => {
    const store = new MemoryStateStore();
    const { ctx, output } = await fakeRun({ store, argv: ['restore'] });
    await restoreKit(ctx, file('kit.json', { state, secrets }));
    const loaded = await store.load('production');
    expect(loaded.state?.zone?.name).toBe('example.com');
    expect(loaded.secrets?.keys.FIELD_KEYS).toBe('k1:test-only');
    expect(output.join('')).toContain('pnpm swarm signin-link');
    expect(output.join('')).not.toContain('test-only');
  });

  it('opens a kit the setup page sealed, with its passphrase, and nothing else', async () => {
    const kit = await sealKit({ state, secrets }, 'test-only kit passphrase', {
      what: 'kit',
      createdAt: '2026-11-19T00:00:00.000Z',
      domain: 'example.com',
    });
    const path = file('sealed.json', kit);
    // The file alone yields no key.
    expect(JSON.stringify(kit)).not.toContain('k1:test-only');

    const wrong = await fakeRun({ argv: ['restore'] });
    process.env.SWARM_KIT_PASSPHRASE = 'not the passphrase';
    try {
      await expect(restoreKit(wrong.ctx, path)).rejects.toThrow(/does not open/);
      process.env.SWARM_KIT_PASSPHRASE = 'test-only kit passphrase';
      const store = new MemoryStateStore();
      const { ctx } = await fakeRun({ store, argv: ['restore'] });
      await restoreKit(ctx, path);
      expect((await store.load('production')).secrets?.keys.FIELD_KEYS).toBe('k1:test-only');
    } finally {
      delete process.env.SWARM_KIT_PASSPHRASE;
    }
  });

  it('never overwrites an install that is already here', async () => {
    const store = new MemoryStateStore({ state, secrets });
    const { ctx } = await fakeRun({ store, argv: ['restore'] });
    await expect(restoreKit(ctx, file('other.json', { state, secrets }))).rejects.toThrow(
      /already an install/,
    );
  });

  it('explains a missing, unreadable or incomplete file', async () => {
    const { ctx } = await fakeRun({ argv: ['restore'] });
    await expect(restoreKit(ctx, undefined)).rejects.toThrow(/Say which file/);
    await expect(restoreKit(ctx, join(dir, 'nope.json'))).rejects.toThrow(/Cannot read/);
    await expect(restoreKit(ctx, file('bad.json', 'not json'))).rejects.toThrow(/Cannot read/);
    await expect(restoreKit(ctx, file('part.json', { secrets }))).rejects.toThrow(
      /isn't a complete/,
    );
  });
});
