// Export destination keys are sealed together with their workspace and destination, like Copilot
// keys, so a sealed value copied onto another row doesn't open. Values sealed before binding still
// open, marked legacy, so the caller can seal them again.
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { encrypt, openCredentials, sealCredentials } from '../src/index';

const keys = parseKeyring(`f1:${'f'.repeat(64)}`);
const credentials = {
  accessKeyId: 'AKIDEXAMPLE1234',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const owner = { workspaceId: 'ws_a', destinationId: 'ed_1' };

describe('export destination key seal', () => {
  it('opens only for the workspace and destination it was sealed for', async () => {
    const sealed = await sealCredentials(keys, owner, credentials);
    expect(sealed).not.toContain('EXAMPLEKEY');
    expect(await openCredentials(keys, owner, sealed)).toEqual({ ...credentials, legacy: false });
    expect(await openCredentials(keys, { ...owner, workspaceId: 'ws_b' }, sealed)).toBeNull();
    expect(await openCredentials(keys, { ...owner, destinationId: 'ed_2' }, sealed)).toBeNull();
    expect(await openCredentials(keys, owner, 'f1.bad.value')).toBeNull();
  });

  it('still opens a value sealed before binding, marked legacy', async () => {
    const legacy = await encrypt(keys, JSON.stringify(credentials));
    expect(await openCredentials(keys, owner, legacy)).toEqual({ ...credentials, legacy: true });
    // Any row can open a legacy value; sealing it again binds it.
    const resealed = await sealCredentials(keys, owner, credentials);
    expect(await openCredentials(keys, { ...owner, workspaceId: 'ws_b' }, resealed)).toBeNull();
  });

  it('refuses a bound value that names only one of the two', async () => {
    const half = await encrypt(keys, JSON.stringify({ w: 'ws_a', ...credentials }));
    expect(await openCredentials(keys, owner, half)).toBeNull();
  });
});
