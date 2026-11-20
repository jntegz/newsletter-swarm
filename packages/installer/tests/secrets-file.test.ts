// .swarm/<env>.secrets.json at rest: sealed under the operator's passphrase, asked for once per
// run, older plain files still read and sealed on the next write, and on Windows limited to the
// current user with icacls. Synthetic keys only, in a temporary folder.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownerOnly } from '../src/acl';
import { secretsPassphrase } from '../src/cli';
import { emptySecrets, FileStateStore, type SecretsPassphrase } from '../src/state';

const KEYRING = 'k20261119:test-only-synthetic-keyring-0123456789abcdefghijklmnopqrstuvwxyz';
const PASSPHRASE = 'test-only secrets passphrase';
const secrets = () => ({ ...emptySecrets(), keys: { FIELD_KEYS: KEYRING } });

function root() {
  return mkdtempSync(join(tmpdir(), 'swarm-secrets-'));
}

/** A passphrase source that records each time it is asked. */
function asked(answer = PASSPHRASE) {
  const calls: string[] = [];
  const passphrase: SecretsPassphrase = async (mode) => {
    calls.push(mode);
    return answer;
  };
  return { calls, passphrase };
}

const secretsFile = (dir: string, env = 'production') => join(dir, '.swarm', `${env}.secrets.json`);

describe('the secrets file at rest', () => {
  it('is sealed: the stored bytes alone yield no key, and the passphrase opens them', async () => {
    const dir = root();
    const first = asked();
    await new FileStateStore(dir, { passphrase: first.passphrase }).saveSecrets(
      'production',
      secrets(),
    );
    const bytes = readFileSync(secretsFile(dir), 'utf8');
    expect(bytes).not.toContain('test-only-synthetic-keyring');
    expect(bytes).not.toContain('FIELD_KEYS');
    expect(JSON.parse(bytes)).toMatchObject({
      format: 'swarm-secrets',
      env: 'production',
      kdf: { name: 'PBKDF2', iterations: 600_000 },
    });
    if (process.platform !== 'win32') expect(statSync(secretsFile(dir)).mode & 0o777).toBe(0o600);

    const later = asked();
    const loaded = await new FileStateStore(dir, { passphrase: later.passphrase }).load(
      'production',
    );
    expect(loaded.secrets?.keys.FIELD_KEYS).toBe(KEYRING);
    expect(later.calls).toEqual(['open']);
  });

  it('refuses a wrong passphrase, and a file moved to the other environment', async () => {
    const dir = root();
    await new FileStateStore(dir, { passphrase: asked().passphrase }).saveSecrets(
      'production',
      secrets(),
    );
    const wrong = new FileStateStore(dir, { passphrase: asked('not the passphrase').passphrase });
    await expect(wrong.load('production')).rejects.toThrow(/does not open/);

    copyFileSync(secretsFile(dir), secretsFile(dir, 'staging'));
    const moved = new FileStateStore(dir, { passphrase: asked().passphrase });
    await expect(moved.load('staging')).rejects.toThrow(/does not open/);
  });

  it('asks once per run, however often the run saves', async () => {
    const dir = root();
    const run = asked();
    const store = new FileStateStore(dir, { passphrase: run.passphrase });
    await store.saveSecrets('production', secrets());
    await store.saveSecrets('production', { ...secrets(), turnstileSecret: 'test-only' });
    expect(run.calls).toEqual(['choose']);

    const next = asked();
    const again = new FileStateStore(dir, { passphrase: next.passphrase });
    const { secrets: loaded } = await again.load('production');
    await again.saveSecrets('production', loaded ?? secrets());
    expect(next.calls).toEqual(['open']);
  });

  it('still reads a plain file from an older installer, and seals it on the next write', async () => {
    const dir = root();
    mkdirSync(join(dir, '.swarm'));
    writeFileSync(secretsFile(dir), JSON.stringify(secrets()));
    const run = asked();
    const store = new FileStateStore(dir, { passphrase: run.passphrase });
    const { secrets: loaded } = await store.load('production');
    expect(loaded?.keys.FIELD_KEYS).toBe(KEYRING);
    expect(run.calls).toEqual([]);

    await store.saveSecrets('production', loaded ?? secrets());
    expect(run.calls).toEqual(['choose']);
    expect(readFileSync(secretsFile(dir), 'utf8')).not.toContain('test-only-synthetic-keyring');
  });

  it('limits the file where it is told to, and says so when that fails', async () => {
    const dir = root();
    const restricted: string[] = [];
    await new FileStateStore(dir, {
      passphrase: asked().passphrase,
      restrict: async (path) => {
        restricted.push(path);
      },
    }).saveSecrets('production', secrets());
    expect(restricted).toEqual([secretsFile(dir)]);

    const warnings: string[] = [];
    await new FileStateStore(dir, {
      passphrase: asked().passphrase,
      restrict: async () => {
        throw new Error('icacls exited 5: Access is denied.');
      },
      warn: (message) => warnings.push(message),
    }).saveSecrets('production', secrets());
    expect(warnings.join('\n')).toMatch(
      /Could not limit .*Access is denied.*keep the \.swarm folder private/s,
    );
  });
});

describe('the Windows file access list', () => {
  it('drops inherited access and grants the current user alone', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const restrict = ownerOnly(
      'win32',
      async (file, args) => {
        calls.push({ file, args });
        return { code: 0, output: '' };
      },
      { USERDOMAIN: 'HOST', USERNAME: 'operator' },
    );
    await restrict?.('C:\\swarm\\.swarm\\production.secrets.json');
    expect(calls).toEqual([
      {
        file: 'icacls',
        args: [
          'C:\\swarm\\.swarm\\production.secrets.json',
          '/inheritance:r',
          '/grant:r',
          'HOST\\operator:F',
        ],
      },
    ]);
  });

  it('fails loudly when icacls does, and is not used where file modes work', async () => {
    const restrict = ownerOnly('win32', async () => ({ code: 5, output: 'Access is denied.' }), {
      USERNAME: 'operator',
    });
    await expect(restrict?.('x')).rejects.toThrow(/icacls exited 5: Access is denied/);
    expect(ownerOnly('darwin')).toBeUndefined();
    expect(ownerOnly('linux')).toBeUndefined();
  });
});

describe('asking for the passphrase', () => {
  const prompter = (answers: string[]) => {
    const messages: string[] = [];
    const prompts = {
      password: async (opts: { message: string }) => {
        messages.push(opts.message);
        return answers.shift() ?? '';
      },
    } as unknown as Parameters<typeof secretsPassphrase>[0];
    return { messages, prompts };
  };

  it('uses SWARM_SECRETS_PASSPHRASE without asking', async () => {
    const ask = secretsPassphrase(null, 'from the environment, long');
    await expect(ask('open', 'f')).resolves.toBe('from the environment, long');
    expect(ask.known()).toBe('from the environment, long');
  });

  it('says how to give it when there is no terminal', async () => {
    await expect(secretsPassphrase(null, undefined)('open', '.swarm/x')).rejects.toThrow(
      /no terminal/,
    );
  });

  it('has a new passphrase typed twice, and asks once per run', async () => {
    const { messages, prompts } = prompter([PASSPHRASE, 'a typo here!', PASSPHRASE, PASSPHRASE]);
    const ask = secretsPassphrase(prompts, undefined);
    await expect(ask('choose', 'f')).resolves.toBe(PASSPHRASE);
    expect(messages).toHaveLength(4);
    await expect(ask('open', 'f')).resolves.toBe(PASSPHRASE);
    expect(messages).toHaveLength(4);
  });
});
