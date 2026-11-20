import { describe, expect, it } from 'vitest';
import { workspaceFlag } from './queries';

describe('workspaceFlag', () => {
  it('takes the publication’s answer, which includes the workspace’s override', () => {
    expect(workspaceFlag(true, true, false)).toBe(true);
    expect(workspaceFlag(true, false, true)).toBe(false);
  });

  it('waits while the publication’s flags load', () => {
    expect(workspaceFlag(true, undefined, true)).toBeUndefined();
  });

  it('takes the instance’s answer with no publication', () => {
    expect(workspaceFlag(false, undefined, true)).toBe(true);
    expect(workspaceFlag(false, undefined, false)).toBe(false);
    expect(workspaceFlag(false, undefined, undefined)).toBeUndefined();
  });

  it('falls back to the instance when the publication’s flags could not be read', () => {
    expect(workspaceFlag(true, null, true)).toBe(true);
    expect(workspaceFlag(true, null, null)).toBeNull();
  });
});
