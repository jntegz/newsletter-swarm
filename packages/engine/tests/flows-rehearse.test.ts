import { describe, expect, it } from 'vitest';
import { nextParam } from '../src/flows-rehearse';

// A rehearsal binds its overlay's values in the parameter after the query's own. A number too low
// reads one of the query's own values; one too high is never bound.
describe('nextParam', () => {
  it('numbers after the highest parameter, gaps and repeats included', () => {
    expect(nextParam('SELECT 1')).toBe(1);
    expect(nextParam('SELECT * FROM t WHERE a = ?1 AND b = ?3 AND c = ?1')).toBe(4);
  });

  it('skips a ? in literals, quoted names and comments', () => {
    expect(nextParam(`SELECT '?9', 'it''s ?9', "a?9" FROM t WHERE a = ?1`)).toBe(2);
    expect(nextParam('SELECT a -- ?9\n FROM t /* ?8 */ WHERE a = ?2')).toBe(3);
  });

  it('skips a ? in names quoted with brackets or backticks', () => {
    expect(nextParam('SELECT 1 AS [a?9], 2 AS `b?8` FROM t WHERE a = ?1')).toBe(2);
  });

  it('still sees parameters after a quoted name holding -- or a quote', () => {
    expect(nextParam('SELECT 1 AS [a--b], ?2 AS c FROM t WHERE a = ?1')).toBe(3);
    expect(nextParam("SELECT 1 AS `it's`, ?2 AS c FROM t WHERE a = ?1 AND b = 'x'")).toBe(3);
  });

  it('refuses unnumbered and named parameters', () => {
    expect(() => nextParam('SELECT * FROM t WHERE a = ?')).toThrow(/numbered/);
    expect(() => nextParam('SELECT * FROM t WHERE a = :a')).toThrow(/numbered/);
    expect(() => nextParam('SELECT * FROM t WHERE a = @a')).toThrow(/numbered/);
  });
});
