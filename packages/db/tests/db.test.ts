import { describe, expect, it } from 'vitest';
import {
  all,
  batch,
  first,
  ipPrefix,
  retryRead,
  retryWhileBusy,
  roleAtLeast,
  run,
  toIso,
} from '../src/index';

describe('first and all', () => {
  const transient = 'D1_ERROR: Failed to get session commit token: internal error; reference = x';
  /** A database whose statements fail this many times before they answer. */
  const flakyDb = (failures: number, message = transient) => {
    let calls = 0;
    const answer = async <T>(value: T) => {
      if (++calls <= failures) throw new Error(message);
      return value;
    };
    const db = {
      prepare: () => ({
        bind: () => ({
          first: () => answer({ id: 1 }),
          all: () => answer({ results: [{ id: 1 }] }),
          run: () => answer({ success: true }),
        }),
      }),
      batch: () => answer([]),
    } as unknown as D1Database;
    return { db, calls: () => calls };
  };

  it('run a SELECT again after a moment of D1 failure', async () => {
    const one = flakyDb(2);
    expect(await first(one.db, 'SELECT id FROM t')).toEqual({ id: 1 });
    expect(one.calls()).toBe(3);
    const many = flakyDb(2);
    expect(await all(many.db, '\n  select id FROM t')).toEqual([{ id: 1 }]);
    expect(many.calls()).toBe(3);
  });

  it('never run a write twice, even one that returns rows', async () => {
    const update = flakyDb(1);
    await expect(first(update.db, 'UPDATE t SET a = 1 RETURNING id')).rejects.toThrow('internal');
    expect(update.calls()).toBe(1);
    const insert = flakyDb(1);
    await expect(all(insert.db, 'INSERT INTO t VALUES (1) RETURNING id')).rejects.toThrow(
      'internal',
    );
    expect(insert.calls()).toBe(1);
  });

  it('run a write again only when the database was busy, when nothing was written', async () => {
    const busy = 'D1_ERROR: database is locked: SQLITE_BUSY';
    const update = flakyDb(2, busy);
    expect(await first(update.db, 'UPDATE t SET a = 1 RETURNING id')).toEqual({ id: 1 });
    expect(update.calls()).toBe(3);
    const write = flakyDb(2, busy);
    await run(write.db, 'UPDATE t SET a = 1');
    expect(write.calls()).toBe(3);
    const together = flakyDb(2, busy);
    await batch(together.db, [{} as D1PreparedStatement]);
    expect(together.calls()).toBe(3);

    const lost = flakyDb(1);
    await expect(run(lost.db, 'UPDATE t SET a = 1')).rejects.toThrow('internal');
    expect(lost.calls()).toBe(1);
    const lostBatch = flakyDb(1);
    await expect(batch(lostBatch.db, [{} as D1PreparedStatement])).rejects.toThrow('internal');
    expect(lostBatch.calls()).toBe(1);
  });

  it('do not retry an error that is not transient, and give up in the end', async () => {
    const broken = flakyDb(1, 'D1_ERROR: no such table: t');
    await expect(first(broken.db, 'SELECT id FROM t')).rejects.toThrow('no such table');
    expect(broken.calls()).toBe(1);
    const down = flakyDb(100);
    await expect(first(down.db, 'SELECT id FROM t')).rejects.toThrow('internal');
    expect(down.calls()).toBe(4);
  });
});

describe('retryRead', () => {
  const flaky = (failures: number, message: string) => {
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls <= failures) throw new Error(message);
      return 'row';
    };
    return { read, calls: () => calls };
  };
  const transient = 'D1_ERROR: Failed to get session commit token: internal error; reference = x';

  it('runs a read again after a transient D1 failure', async () => {
    const { read, calls } = flaky(2, transient);
    expect(await retryRead(read, 3, 1)).toBe('row');
    expect(calls()).toBe(3);
  });

  it('gives up after its attempts', async () => {
    const { read, calls } = flaky(5, transient);
    await expect(retryRead(read, 3, 1)).rejects.toThrow('internal error');
    expect(calls()).toBe(3);
  });

  it('never retries anything else', async () => {
    const { read, calls } = flaky(1, 'D1_ERROR: no such table: members');
    await expect(retryRead(read, 3, 1)).rejects.toThrow('no such table');
    expect(calls()).toBe(1);
  });
});

describe('retryWhileBusy', () => {
  it('runs work again when the database is locked, and for nothing else', async () => {
    let calls = 0;
    const work = async () => {
      if (++calls < 3) throw new Error('D1_ERROR: database is locked: SQLITE_BUSY');
      return 'done';
    };
    expect(await retryWhileBusy(work, 5, 1)).toBe('done');
    expect(calls).toBe(3);

    let once = 0;
    const lost = async () => {
      once++;
      throw new Error('D1_ERROR: internal error');
    };
    await expect(retryWhileBusy(lost, 5, 1)).rejects.toThrow('internal error');
    expect(once).toBe(1);
  });
});

describe('roleAtLeast', () => {
  it('orders roles from viewer to owner', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('author', 'editor')).toBe(false);
    expect(roleAtLeast('viewer', 'author')).toBe(false);
  });
});

describe('toIso', () => {
  it('formats milliseconds as ISO 8601', () => {
    expect(toIso(Date.UTC(2026, 9, 27))).toBe('2026-10-27T00:00:00.000Z');
  });
});

describe('ipPrefix', () => {
  it('keeps the /24 of IPv4 and the /48 of IPv6, never the full address', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('2001:0DB8:00ab:1:2:3:4:5')).toBe('2001:db8:ab::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
    for (const bad of [null, undefined, '', 'unknown', '1.2.3', '999.1.1.1', 'fe80::1%eth0']) {
      expect(ipPrefix(bad)).toBeNull();
    }
  });
});
