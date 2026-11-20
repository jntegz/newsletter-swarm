import {
  BULK_MAX_MEMBERS,
  DEFAULT_PAUSE_DAYS as DOMAIN_DEFAULT_PAUSE_DAYS,
  IMPORT_MAX_BYTES as DOMAIN_IMPORT_MAX_BYTES,
  MAX_LIST_FIELDS,
  MAX_PAUSE_DAYS as DOMAIN_MAX_PAUSE_DAYS,
  MEMBER_STATUSES as DOMAIN_STATUSES,
  WARM_IMPORT_THRESHOLD,
  nextStatuses,
  type MemberField,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  engagementDetail,
  engagementText,
  BULK_MAX,
  DEFAULT_COLUMNS,
  DEFAULT_PAUSE_DAYS,
  IMPORT_MAX_BYTES,
  MAX_FIELD_COLUMNS,
  MAX_PAUSE_DAYS,
  MEMBER_STATUSES,
  WARM_IMPORT_AT,
  changedFields,
  checkMapping,
  columnsStorageKey,
  fieldColumnKeys,
  fieldText,
  fromDraft,
  keyFromLabel,
  mappingIsValid,
  operatorNext,
  pauseBounds,
  readColumns,
  statusActions,
  toDraft,
  toggleColumn,
  writeColumns,
} from './members-helpers';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const field = (key: string, type: MemberField['type'], options: string[] = []): MemberField => ({
  id: `mf_${'0'.repeat(32)}`,
  channelId: `ch_${'0'.repeat(32)}`,
  key,
  label: key,
  type,
  options,
  encrypted: false,
  position: 0,
  createdAt: '2026-10-27T12:00:00.000Z',
});

describe('rules copied from @swarm/domain', () => {
  it('match the domain package', () => {
    expect(MEMBER_STATUSES).toEqual(DOMAIN_STATUSES);
    expect(BULK_MAX).toBe(BULK_MAX_MEMBERS);
    expect(DEFAULT_PAUSE_DAYS).toBe(DOMAIN_DEFAULT_PAUSE_DAYS);
    expect(MAX_PAUSE_DAYS).toBe(DOMAIN_MAX_PAUSE_DAYS);
    expect(WARM_IMPORT_AT).toBe(WARM_IMPORT_THRESHOLD);
    expect(IMPORT_MAX_BYTES).toBe(DOMAIN_IMPORT_MAX_BYTES);
    for (const status of DOMAIN_STATUSES) {
      expect(operatorNext(status)).toEqual(nextStatuses(status, 'operator'));
    }
  });
});

describe('column persistence', () => {
  const key = columnsStorageKey('op_1');

  it('keeps choices per teammate', () => {
    expect(columnsStorageKey('op_1')).not.toBe(columnsStorageKey('op_2'));
  });

  it('falls back to the defaults when nothing is stored', () => {
    expect(readColumns(memoryStorage(), key)).toEqual(DEFAULT_COLUMNS);
    expect(readColumns(null, key)).toEqual(DEFAULT_COLUMNS);
  });

  it('round-trips a choice in table order and drops unknown columns', () => {
    const storage = memoryStorage();
    writeColumns(storage, key, ['joined', 'name']);
    expect(readColumns(storage, key)).toEqual(['name', 'joined']);
    storage.setItem(key, JSON.stringify(['status', 'secret', 4]));
    expect(readColumns(storage, key)).toEqual(['status']);
  });

  it('survives broken or blocked storage', () => {
    expect(readColumns(memoryStorage({ [key]: '{nope' }), key)).toEqual(DEFAULT_COLUMNS);
    expect(readColumns(memoryStorage({ [key]: '"name"' }), key)).toEqual(DEFAULT_COLUMNS);
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readColumns(throwing, key)).toEqual(DEFAULT_COLUMNS);
    expect(() => writeColumns(throwing, key, ['name'])).not.toThrow();
  });

  it('toggles a column while keeping table order', () => {
    expect(toggleColumn(['name', 'joined'], 'status')).toEqual(['name', 'status', 'joined']);
    expect(toggleColumn(['name', 'joined'], 'name')).toEqual(['joined']);
  });

  it('keeps profile field columns after the built-in ones, in the order added', () => {
    const storage = memoryStorage();
    let columns = toggleColumn(['name'], 'field:plan');
    columns = toggleColumn(columns, 'field:age');
    columns = toggleColumn(columns, 'status');
    expect(columns).toEqual(['name', 'status', 'field:plan', 'field:age']);
    writeColumns(storage, key, columns);
    storage.setItem(key, JSON.stringify([...columns, 'field:Bad Key', 'field:']));
    expect(readColumns(storage, key)).toEqual(['name', 'status', 'field:plan', 'field:age']);
    expect(toggleColumn(columns, 'field:plan')).toEqual(['name', 'status', 'field:age']);
  });

  it('asks only for fields that still exist, and caps the field columns', () => {
    expect(MAX_FIELD_COLUMNS).toBe(MAX_LIST_FIELDS);
    expect(
      fieldColumnKeys(['name', 'field:plan', 'field:gone'], [field('plan', 'select')]),
    ).toEqual(['plan']);
    const full = Array.from({ length: MAX_FIELD_COLUMNS }, (_, i) => `field:k${i}` as const);
    expect(toggleColumn(full, 'field:one_more')).toBe(full);
    expect(toggleColumn(full, 'name')[0]).toBe('name');
  });

  it('shows field values as text', () => {
    expect(fieldText(['Bees', 'Wax'])).toBe('Bees, Wax');
    expect(fieldText(true)).toBe('Yes');
    expect(fieldText(42)).toBe('42');
    expect(fieldText(null)).toBeNull();
    expect(fieldText([])).toBeNull();
  });
});

describe('import mapping', () => {
  const fields = [field('company', 'text')];

  it('needs an email column', () => {
    const check = checkMapping({ Name: 'first_name', Mail: null }, fields);
    expect(check.general).toMatch(/email/);
    expect(mappingIsValid(check)).toBe(false);
  });

  it('has no problem for columns named like Object.prototype members', () => {
    // Column names come from the file.
    const check = checkMapping({ Email: 'email', constructor: null, toString: 'tags' }, fields);
    expect(check.columns.constructor).toBeUndefined();
    expect(check.columns.toString).toBeUndefined();
    expect(mappingIsValid(check)).toBe(true);
  });

  it('accepts one column per target, and any number of tag columns', () => {
    const check = checkMapping(
      { Email: 'email', First: 'first_name', A: 'tags', B: 'tags', Co: 'field:company' },
      fields,
    );
    expect(mappingIsValid(check)).toBe(true);
  });

  it('flags a second column going to the same place, and unknown fields', () => {
    const check = checkMapping(
      { Email: 'email', Other: 'email', Gone: 'field:missing', Name: 'first_name' },
      fields,
    );
    expect(check.general).toBeNull();
    expect(check.columns.Other).toContain('Email');
    expect(check.columns.Gone).toMatch(/no profile field/);
    expect(check.columns.Name).toBeUndefined();
  });
});

describe('profile field drafts', () => {
  it('converts values to drafts and back', () => {
    expect(toDraft('boolean', true)).toBe('yes');
    expect(fromDraft('boolean', 'no')).toBe(false);
    expect(fromDraft('boolean', '')).toBeNull();
    expect(fromDraft('number', ' 42 ')).toBe(42);
    expect(fromDraft('number', 'abc')).toBe('abc');
    expect(toDraft('multi_select', null)).toEqual([]);
    expect(fromDraft('multi_select', [])).toBeNull();
    expect(fromDraft('date', '2026-10-27')).toBe('2026-10-27');
  });

  it('sends only what changed', () => {
    const fields = [field('plan', 'select', ['a', 'b']), field('n', 'number'), field('t', 'text')];
    const saved = { plan: 'a', n: 3 };
    expect(changedFields(fields, saved, { plan: 'a', n: '3', t: '' })).toEqual({});
    expect(changedFields(fields, saved, { plan: 'b', n: '', t: 'hi' })).toEqual({
      plan: 'b',
      n: null,
      t: 'hi',
    });
  });
});

describe('statuses', () => {
  it('offers only the transitions a teammate may make', () => {
    expect(statusActions('pending').map((a) => a.to)).toEqual(['unsubscribed']);
    expect(statusActions('active').map((a) => a.label)).toEqual(['Pause', 'Unsubscribe']);
    expect(statusActions('paused').map((a) => a.label)).toEqual(['Resume', 'Unsubscribe']);
    expect(statusActions('unsubscribed')).toEqual([]);
    expect(statusActions('bounced')).toEqual([]);
  });

  it('bounds a pause between tomorrow and a year out', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(pauseBounds(now)).toEqual({
      min: '2026-10-28',
      max: '2027-10-27',
      initial: '2026-11-24',
    });
  });
});

describe('field keys', () => {
  it('suggests a key from a label', () => {
    expect(keyFromLabel('Company name')).toBe('company_name');
    expect(keyFromLabel('2nd Café visit!')).toBe('nd_cafe_visit');
    expect(keyFromLabel('***')).toBe('');
  });
});

describe('engagement wording', () => {
  const base = {
    score: 72,
    band: 'very_engaged',
    sentCount: 4,
    openedCount: 3,
    clickedCount: 1,
    lastEngagedAt: null,
    computedAt: '2026-11-04T00:00:00.000Z',
  } as const;

  it('shows the level, with the score when there is one', () => {
    expect(engagementText(null)).toBe('—');
    expect(engagementText(base)).toBe('Very engaged (72)');
    expect(engagementText({ ...base, score: null, band: 'opens_hidden' })).toBe('Opens hidden');
  });

  it('says why', () => {
    expect(engagementDetail(base)).toContain('Opened 3 and clicked in 1 of the 4 posts');
    expect(
      engagementDetail({ ...base, score: null, band: 'too_few_posts', sentCount: 1 }),
    ).toContain('1 post reached them');
    expect(engagementDetail({ ...base, score: null, band: 'opens_hidden' })).toContain(
      'privacy service',
    );
  });
});
