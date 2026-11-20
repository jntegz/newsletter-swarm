import type { DispatchStatus, PreflightCheck } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { audienceSummary, sendBlockedReason, showsSendRoute, writeIsDone } from './send-helpers';

describe('showsSendRoute', () => {
  it('is for posts that can still go out', () => {
    const shown = (status: DispatchStatus) => showsSendRoute(status);
    expect(shown('draft')).toBe(true);
    expect(shown('scheduled')).toBe(true);
    expect(shown('sending')).toBe(false);
    expect(shown('sent')).toBe(false);
    expect(shown('canceled')).toBe(false);
  });
});

describe('writeIsDone', () => {
  const emptyCheck: PreflightCheck = { key: 'content', ok: false, message: 'This post is empty.' };

  it('needs no words: an image-only or button-only post passes the content check', () => {
    expect(writeIsDone('Spring guide', [])).toBe(true);
  });

  it('follows the server when it finds no content', () => {
    expect(writeIsDone('Spring guide', [emptyCheck])).toBe(false);
  });

  it('needs a subject', () => {
    expect(writeIsDone('   ', [])).toBe(false);
  });
});

describe('audienceSummary', () => {
  const names = new Map([
    ['cl_a', 'Readers'],
    ['cl_b', 'Lapsed'],
  ]);
  const base = {
    chosen: true,
    audience: { include: [] as string[], exclude: [] as string[] },
    names,
    rosters: null,
    count: null,
  };

  it('asks for a choice first', () => {
    expect(audienceSummary({ ...base, chosen: false, count: 5 })).toBe('Not chosen yet');
  });

  it('says what is left out of everyone', () => {
    expect(audienceSummary({ ...base, audience: { include: [], exclude: ['cl_b'] } })).toBe(
      'Everyone, except subscribers in Lapsed',
    );
  });

  it('names segments, what is left out, rosters and the count', () => {
    expect(
      audienceSummary({
        ...base,
        audience: { include: ['cl_a'], exclude: ['cl_b'] },
        rosters: 'only subscribers on Weekly',
        count: 1200,
      }),
    ).toBe(
      'Subscribers in Readers, except subscribers in Lapsed, only subscribers on Weekly · 1,200',
    );
  });
});

describe('sendBlockedReason', () => {
  const ready = {
    canSend: true,
    canWrite: true,
    writeDone: true,
    writeProblem: undefined,
    whoDone: true,
    checking: false,
    checksError: null,
    ready: true,
    firstProblem: undefined,
    needsTime: false,
  };

  it('lets a ready post go', () => {
    expect(sendBlockedReason(ready)).toBeNull();
  });

  it('tells an author who sends, and what they can still do', () => {
    expect(sendBlockedReason({ ...ready, canSend: false })).toBe(
      'An editor or admin sends posts. You can write and send tests.',
    );
  });

  it('does not offer a viewer writing or tests', () => {
    expect(sendBlockedReason({ ...ready, canSend: false, canWrite: false })).toBe(
      'An editor or admin sends posts.',
    );
  });

  it('gives the first thing to fix, in route order', () => {
    expect(
      sendBlockedReason({
        ...ready,
        writeDone: false,
        writeProblem: 'Add a subject.',
        whoDone: false,
      }),
    ).toBe('Add a subject.');
    expect(sendBlockedReason({ ...ready, whoDone: false, checking: true })).toBe(
      'Choose who gets this post first.',
    );
    expect(sendBlockedReason({ ...ready, checking: true })).toBe('Checking the post…');
    expect(sendBlockedReason({ ...ready, checksError: 'Offline' })).toBe(
      'The checks didn’t run: Offline',
    );
    expect(sendBlockedReason({ ...ready, ready: false, firstProblem: 'DMARC is missing.' })).toBe(
      'DMARC is missing.',
    );
    expect(sendBlockedReason({ ...ready, needsTime: true })).toBe('Pick a date and time.');
  });
});

describe('inboxAdvice', () => {
  it('leaves preview text to the panel’s own row and survives an older API', async () => {
    const { inboxAdvice } = await import('./send-helpers');
    expect(
      inboxAdvice([
        { id: 'preview_text', message: 'There is no preview text.' },
        { id: 'link_shortener', message: 'A link goes through a public link shortener.' },
      ]).map((item) => item.id),
    ).toEqual(['link_shortener']);
    expect(inboxAdvice(undefined)).toEqual([]);
  });
});
