import type { SectionInstance, SectionSchema } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import {
  MAX_SECTIONS,
  addProblem,
  addSection,
  dropSection,
  duplicateSection,
  moveSection,
  newSectionId,
  removeSection,
  renameSectionType,
  sectionNotes,
  sectionTitle,
  updateSection,
} from './sections';

const s = (id: string, type = id.replace(/-\d+$/, '')): SectionInstance => ({
  id,
  type,
  settings: {},
});
const page = [s('hero-1'), s('benefits-1'), s('latest-1')];
const schema = (name: string, limit?: number): SectionSchema => ({
  name,
  settings: [],
  ...(limit ? { limit } : {}),
});
const ids = (list: SectionInstance[]) => list.map((x) => x.id);

describe('ids', () => {
  it('takes the next free number for the type', () => {
    expect(newSectionId('hero', page)).toBe('hero-2');
    expect(newSectionId('faq', page)).toBe('faq-1');
    expect(newSectionId('subscribe_band', [s('subscribe_band-1')])).toBe('subscribe_band-2');
  });
});

describe('adding', () => {
  const schemas = { hero: schema('Hero', 1), faq: schema('Questions') };
  it('respects a type’s limit and the page’s', () => {
    expect(addProblem(schemas, page, 'hero')).toBe('Already on the page.');
    expect(addProblem(schemas, page, 'faq')).toBeNull();
    expect(addProblem(schemas, page, 'missing')).toMatch(/no such section/);
    const full = Array.from({ length: MAX_SECTIONS }, (_, i) => s(`faq-${i + 1}`));
    expect(addProblem(schemas, full, 'faq')).toMatch(/at most 30/);
  });

  it('adds at the end, or after a section', () => {
    expect(ids(addSection(page, 'faq').sections)).toEqual([
      'hero-1',
      'benefits-1',
      'latest-1',
      'faq-1',
    ]);
    expect(ids(addSection(page, 'faq', 0).sections)).toEqual([
      'hero-1',
      'faq-1',
      'benefits-1',
      'latest-1',
    ]);
  });
});

describe('editing the list', () => {
  it('duplicates right after, with its own id and a copy of its settings', () => {
    const list = [{ ...s('text-1'), settings: { heading: 'Why' } }];
    const { sections, added } = duplicateSection(list, 'text-1');
    expect(ids(sections)).toEqual(['text-1', 'text-2']);
    expect(added?.settings).toEqual({ heading: 'Why' });
    expect(added?.settings).not.toBe(list[0]!.settings);
  });

  it('removes and says where it was', () => {
    const { sections, removed, index } = removeSection(page, 'benefits-1');
    expect(ids(sections)).toEqual(['hero-1', 'latest-1']);
    expect(removed?.id).toBe('benefits-1');
    expect(index).toBe(1);
  });

  it('moves up and down within the list', () => {
    expect(ids(moveSection(page, 'latest-1', -1))).toEqual(['hero-1', 'latest-1', 'benefits-1']);
    expect(ids(moveSection(page, 'hero-1', -1))).toEqual(ids(page));
    expect(ids(moveSection(page, 'latest-1', 1))).toEqual(ids(page));
  });

  it('drops into the gap it was dropped in', () => {
    expect(ids(dropSection(page, 'hero-1', 3))).toEqual(['benefits-1', 'latest-1', 'hero-1']);
    expect(ids(dropSection(page, 'latest-1', 0))).toEqual(['latest-1', 'hero-1', 'benefits-1']);
    expect(ids(dropSection(page, 'hero-1', 1))).toEqual(ids(page));
  });

  it('leaves the defaults out of what is saved', () => {
    const [changed] = updateSection([s('hero-1')], 'hero-1', {
      hidden: false,
      audience: 'everyone',
      device: 'all',
    });
    expect(changed).toEqual(s('hero-1'));
    const [kept] = updateSection([s('hero-1')], 'hero-1', { audience: 'subscribers' });
    expect(kept?.audience).toBe('subscribers');
  });

  it('follows a section file that was renamed', () => {
    expect(renameSectionType(page, 'benefits', 'perks')?.[1]?.type).toBe('perks');
    expect(renameSectionType(null, 'a', 'b')).toBeNull();
  });
});

describe('words', () => {
  it('says where a section shows, only when it isn’t everywhere', () => {
    expect(sectionNotes(s('hero-1'))).toEqual([]);
    expect(
      sectionNotes({ ...s('hero-1'), hidden: true, audience: 'subscribers', device: 'phone' }),
    ).toEqual(['Hidden', 'Subscribers only', 'Phones only']);
  });

  it('names a section with its heading', () => {
    expect(sectionTitle({ ...s('text-1'), settings: { heading: ' Why I write ' } }, schema('Text'))).toEqual(
      { name: 'Text', detail: 'Why I write' },
    );
    expect(sectionTitle(s('odd-1'), undefined)).toEqual({ name: 'odd', detail: null });
  });
});
