// `pnpm swarm enable debounce` and its doctor check (docs/email-verification.md): the key becomes
// DEBOUNCE_API_KEY on the api, capture and jobs workers, is kept in .swarm/<env>.secrets.json, and
// is checked with DeBounce's balance call (skipped in a dry run).
import { describe, expect, it } from 'vitest';
import { doctor } from '../src/commands/doctor';
import { debounceBalance, enable } from '../src/commands/enable';
import { FakeTransport } from '../src/fake';
import { secretNames, secretContext } from '../src/keys';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { answers, fakeRun } from './helpers';

async function installed() {
  const store = new MemoryStateStore();
  const transport = new FakeTransport({ zone: 'example.com' });
  const first = await fakeRun({ argv: ['--dry-run'], store, transport });
  await runSteps(first.ctx, INSTALL_STEPS);
  return { store, transport };
}

describe('enable debounce', () => {
  it('stores the key and deploys it to the workers that call DeBounce', async () => {
    const { store, transport } = await installed();
    const before = transport.actions.length;
    const output: string[] = [];
    const { ctx } = await fakeRun({
      argv: ['enable', 'debounce', '--dry-run'],
      store,
      transport,
      output,
      answers: { ...(await answers()), debounceApiKey: 'abcdefghij123' },
    });
    await enable(ctx, 'debounce');
    expect(ctx.secrets.debounceApiKey).toBe('abcdefghij123');
    expect(ctx.state.features.debounce).toBe(true);
    const text = output.join('');
    expect(text).toContain('https://tegze.link/debounce');
    expect(text).toContain('skipped in a dry run');
    const deployed = transport.actions
      .slice(before)
      .filter((a) => a.startsWith('wrangler deploy'))
      .map((a) => /workers\/(\w+)\//.exec(a)?.[1]);
    // Capture's signup check goes through the vault, which holds the key.
    expect(deployed).toEqual(['vault', 'jobs', 'api']);
    for (const script of ['swarm-api', 'swarm-jobs', 'swarm-vault']) {
      expect(transport.secrets.get(script)).toEqual(expect.arrayContaining(['DEBOUNCE_API_KEY']));
    }
    expect(transport.secrets.get('swarm-send') ?? []).not.toContain('DEBOUNCE_API_KEY');
    // Nothing is sent to DeBounce in a dry run.
    expect(transport.actions.some((a) => a.includes('debounce.io'))).toBe(false);
  });

  it('asks for the key in a non-interactive run that has none', async () => {
    const { store, transport } = await installed();
    const { ctx } = await fakeRun({ argv: ['enable', 'debounce', '--dry-run'], store, transport });
    await expect(enable(ctx, 'debounce')).rejects.toThrow('DeBounce API key');
  });

  it('adds the secret only once the feature is on', () => {
    const state = { features: { customDomains: false, payments: false, google: false } };
    const ctx = secretContext(state as never, { version: 1, keys: {} });
    expect(secretNames('jobs', ctx)).not.toContain('DEBOUNCE_API_KEY');
    const on = { ...ctx, features: { ...ctx.features, debounce: true } };
    expect(secretNames('jobs', on)).toContain('DEBOUNCE_API_KEY');
    // Capture's signup check goes through the vault's proxy: capture never holds it.
    expect(secretNames('capture', on)).not.toContain('DEBOUNCE_API_KEY');
  });
});

describe('checking the key', () => {
  it('reads the balance, and says how to fix a refused key', async () => {
    const { ctx, transport } = await fakeRun({});
    const seen: string[] = [];
    let status = 200;
    transport.http = async (request) => {
      seen.push(request.url);
      return status === 200
        ? { status, text: '{"balance":"1087306"}' }
        : { status, text: '{"debounce":{"error":"Wrong API"},"success":"0"}' };
    };
    expect(await debounceBalance(ctx, 'abcdefghij123')).toBe(1_087_306);
    expect(seen[0]).toBe('https://api.debounce.io/v1/balance/?api=abcdefghij123');
    status = 401;
    await expect(debounceBalance(ctx, 'abcdefghij123')).rejects.toThrow('did not accept');
  });

  it('doctor reports DeBounce, without asking it in a dry run', async () => {
    const { store, transport } = await installed();
    const base = await answers();
    const first = await fakeRun({
      argv: ['enable', 'debounce', '--dry-run'],
      store,
      transport,
      answers: { ...base, debounceApiKey: 'abcdefghij123' },
    });
    await enable(first.ctx, 'debounce');
    const output: string[] = [];
    const { ctx } = await fakeRun({ argv: ['doctor', '--dry-run'], store, transport, output });
    expect(await doctor(ctx)).toBe(true);
    expect(output.join('')).toMatch(/DeBounce \(DEBOUNCE_API_KEY\).*set; not asked in a dry run/);
  });
});
