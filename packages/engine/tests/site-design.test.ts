import type { SiteDesign } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  builtInThemeFiles,
  designProblems,
  hasDesignErrors,
  publishSiteDesign,
} from '../src/site-design';

const launch: SiteDesign = { theme: 'launch', files: null, settings: {}, sections: null };
const broken: SiteDesign = { ...launch, sections: [{ id: 'n', type: 'nope', settings: {} }] };

/** A database that fails the test if anything reaches it. */
const untouched = new Proxy({} as D1Database, {
  get: (_target, key) => {
    throw new Error(`the database was used (${String(key)})`);
  },
});

describe('publishing a website design', () => {
  it('checks a design against its built-in theme', () => {
    expect(builtInThemeFiles('launch')).toBeTruthy();
    expect(builtInThemeFiles('nope')).toBeNull();
    expect(hasDesignErrors(designProblems(launch))).toBe(false);
    const problems = designProblems(broken);
    expect(hasDesignErrors(problems)).toBe(true);
    expect(problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/no “nope” section/)]),
    );
    expect(
      hasDesignErrors(designProblems({ ...launch, theme: 'gone' as SiteDesign['theme'] })),
    ).toBe(true);
  });

  it('refuses a design with errors before writing anything, scheduled or not', async () => {
    for (const schedule of [undefined, { token: 't', publishAt: 1 }]) {
      const result = await publishSiteDesign(untouched, {
        channelId: 'ch_x',
        workspaceId: 'ws_x',
        design: broken,
        operatorId: null,
        now: 1,
        ...(schedule ? { schedule } : {}),
      });
      expect(result.status).toBe('refused');
    }
  });
});
