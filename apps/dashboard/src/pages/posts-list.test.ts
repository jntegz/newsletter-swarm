import { describe, expect, it } from 'vitest';
import {
  archiveToastText,
  authorName,
  cleanSearch,
  listFilterFor,
  percent,
  postsListSearch,
  sendRates,
  startedByLabel,
} from './posts-list';

describe('the posts list in the address', () => {
  it('keeps known values and drops the rest', () => {
    expect(postsListSearch({ q: '  slow web ', show: 'sent', by: 'agents', channel: 'x' })).toEqual(
      { q: 'slow web', show: 'sent', by: 'agents' },
    );
    expect(postsListSearch({ q: '', show: 'canceled', by: 'robots' })).toEqual({});
    expect(postsListSearch({ q: 'a'.repeat(300) }).q).toHaveLength(100);
    expect(cleanSearch({ q: '', show: undefined, by: 'people' })).toEqual({ by: 'people' });
  });

  it('asks the API for the chip, and ignores Archived while the archive is off', () => {
    expect(listFilterFor({ show: 'draft', q: 'x' }, true)).toEqual({
      archived: 'exclude',
      status: 'draft',
      q: 'x',
      startedBy: undefined,
    });
    expect(listFilterFor({ show: 'archived', by: 'people' }, true)).toMatchObject({
      archived: 'only',
      status: undefined,
      startedBy: 'people',
    });
    expect(listFilterFor({ show: 'archived' }, false)).toMatchObject({
      archived: 'exclude',
      status: undefined,
    });
  });
});

describe('the posts list’s words', () => {
  it('names the author, falling back to the email', () => {
    expect(authorName({ author: { id: 'op_1', name: 'Mara Lind', email: 'm@x.dev' } })).toBe(
      'Mara Lind',
    );
    expect(authorName({ author: { id: 'op_1', name: null, email: 'm@x.dev' } })).toBe('m@x.dev');
    expect(authorName({ author: null })).toBe('Teammate');
  });

  it('shows rates with one decimal, and nothing before anything is delivered', () => {
    expect(percent(0.4823)).toBe('48.2%');
    expect(percent(0.46)).toBe('46.0%');
    const send = {
      broadcastId: 'br_1',
      delivered: 10,
      humanOpens: 5,
      humanClicks: 1,
      openRate: 0.5,
      clickRate: 0.1,
    };
    expect(sendRates({ latestSend: send })).toEqual({ opens: '50.0%', clicks: '10.0%' });
    expect(sendRates({ latestSend: { ...send, delivered: 0 } })).toBeNull();
    expect(sendRates({ latestSend: null })).toBeNull();
    expect(sendRates({})).toBeNull();
  });

  it('labels the Started by filter', () => {
    expect(startedByLabel(undefined)).toBeNull();
    expect(startedByLabel('people')).toBe('Started by a teammate');
  });

  it('says what archiving changed and what it refused', () => {
    expect(archiveToastText('archive', { changed: ['a', 'b'], refused: [] })).toBe(
      'Archived 2 posts',
    );
    expect(archiveToastText('restore', { changed: ['a'], refused: [] })).toBe('Restored 1 post');
    expect(
      archiveToastText('archive', {
        changed: ['a'],
        refused: [{ id: 'b', message: 'It’s scheduled to send. Unschedule it first.' }],
      }),
    ).toBe('Archived 1 post. 1 post wasn’t changed: It’s scheduled to send. Unschedule it first.');
    expect(
      archiveToastText('archive', {
        changed: [],
        refused: [
          { id: 'a', message: 'No.' },
          { id: 'b', message: 'No.' },
        ],
      }),
    ).toBe('2 posts weren’t changed: No.');
  });
});
