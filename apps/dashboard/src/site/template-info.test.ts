import { describe, expect, it } from 'vitest';
import { accentNote } from './template-info';

describe('accent colour note', () => {
  it('explains what happens to a light or a very dark colour, and says nothing otherwise', () => {
    expect(accentNote('#ffe14d')).toMatch(/light colour/);
    expect(accentNote('#0a0a0a')).toMatch(/very dark/);
    expect(accentNote('#ff6600')).toMatch(/dark text/);
    expect(accentNote('#6c4cf1')).toBeNull();
    expect(accentNote('purple')).toBeNull();
  });
});
