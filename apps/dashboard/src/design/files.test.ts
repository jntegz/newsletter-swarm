import { compileTheme } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import {
  addFile,
  baseName,
  deleteFile,
  exportFileName,
  fileNameProblem,
  fileTree,
  languageOf,
  offsetAt,
  parseThemeFile,
  problemsByFile,
  renameFile,
  starterFile,
  toBaseName,
  uniqueProblems,
} from './files';

const files = {
  'theme.css': '',
  'sections/hero.html': "<h1>Hi</h1>{% render 'card' %}{% subscribe_form %}",
  'theme.json': '{"name":"T","settings":[],"sections":[{"type":"hero"}]}',
  'snippets/card.html': '<p>card</p>',
  'layout.html': "{% sections %}{% section 'hero' %}",
};

describe('the tree', () => {
  it('lists the theme files first, then each folder in order', () => {
    expect(fileTree({ ...files, 'sections/about.html': '' })).toEqual({
      root: ['theme.json', 'layout.html', 'theme.css'],
      sections: ['sections/about.html', 'sections/hero.html'],
      snippets: ['snippets/card.html'],
    });
    expect(baseName('sections/hero.html')).toBe('hero');
    expect(languageOf('theme.json')).toBe('json');
    expect(languageOf('theme.css')).toBe('css');
    expect(languageOf('snippets/card.html')).toBe('html');
  });
});

describe('names', () => {
  it('checks a new file’s name', () => {
    expect(fileNameProblem(files, 'sections', 'pull_quote')).toBeNull();
    expect(fileNameProblem(files, 'sections', 'hero')).toMatch(/already/);
    expect(fileNameProblem(files, 'sections', 'hero', 'sections/hero.html')).toBeNull();
    expect(fileNameProblem(files, 'snippets', 'Card!')).toMatch(/lower case/);
    expect(fileNameProblem(files, 'snippets', '')).toMatch(/name/);
    expect(toBaseName(' Pull quote.html ')).toBe('pull_quote');
  });
});

describe('changing files', () => {
  it('adds a section that compiles, with its schema', () => {
    const added = addFile(files, 'sections/pull_quote.html', starterFile('sections', 'pull_quote'));
    const { theme, problems } = compileTheme(added);
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(theme?.schemas.pull_quote?.name).toBe('Pull quote');
    const snippet = compileTheme(addFile(files, 'snippets/note.html', starterFile('snippets', 'note')));
    expect(snippet.problems.filter((p) => p.file === 'snippets/note.html')).toEqual([]);
  });

  it('deletes without touching the rest', () => {
    const next = deleteFile(files, 'snippets/card.html');
    expect(Object.keys(next)).not.toContain('snippets/card.html');
    expect(Object.keys(files)).toContain('snippets/card.html');
  });

  it('renames a snippet and the tags that use it', () => {
    const next = renameFile(files, 'snippets/card.html', 'snippets/post_card.html');
    expect(next['snippets/post_card.html']).toBe('<p>card</p>');
    expect(next['snippets/card.html']).toBeUndefined();
    expect(next['sections/hero.html']).toContain("{% render 'post_card' %}");
  });

  it('renames a section and the fixed section tags', () => {
    const next = renameFile(files, 'sections/hero.html', 'sections/intro.html');
    expect(next['layout.html']).toBe("{% sections %}{% section 'intro' %}");
  });
});

describe('problems', () => {
  const p = (file: string, line: number, severity: 'error' | 'warning' = 'error') => ({
    file,
    line,
    column: 1,
    message: `m${line}`,
    severity,
  });

  it('groups by file, errors first, in order', () => {
    const grouped = problemsByFile([p('b', 3), p('a', 9, 'warning'), p('b', 1), p('a', 2)]);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('b')?.map((x) => x.line)).toEqual([1, 3]);
    expect(grouped.get('a')?.map((x) => x.line)).toEqual([2, 9]);
  });

  it('shows the same problem once', () => {
    expect(uniqueProblems([p('a', 1), p('a', 1), p('a', 2)])).toHaveLength(2);
  });

  it('finds a line and column in the text, kept inside it', () => {
    const text = 'ab\ncdef\ng';
    expect(offsetAt(text, 1, 1)).toBe(0);
    expect(offsetAt(text, 2, 3)).toBe(5);
    expect(offsetAt(text, 2, 99)).toBe(7);
    expect(offsetAt(text, 9, 1)).toBe(8);
  });
});

describe('export and import', () => {
  it('names the download after the theme', () => {
    expect(exportFileName('Launch (Field Notes)')).toBe('launch-field-notes.swarm-theme.json');
    expect(exportFileName('!!!')).toBe('theme.swarm-theme.json');
  });

  it('reads an exported theme and refuses anything else', () => {
    const good = JSON.stringify({ format: 'swarm-theme', version: 1, name: 'T', files });
    expect(parseThemeFile(good)).toEqual({
      theme: { format: 'swarm-theme', version: 1, name: 'T', files },
    });
    expect(parseThemeFile('nope')).toEqual({ problem: expect.stringMatching(/isn’t JSON/) });
    expect(parseThemeFile('{"format":"other"}')).toEqual({
      problem: expect.stringMatching(/isn’t a Swarm theme/),
    });
    expect(parseThemeFile('{"format":"swarm-theme","version":2,"files":{}}')).toEqual({
      problem: expect.stringMatching(/newer version/),
    });
    expect(
      parseThemeFile('{"format":"swarm-theme","version":1,"files":{"theme.css":""}}'),
    ).toEqual({ problem: expect.stringMatching(/no theme.json/) });
    expect(parseThemeFile('{"format":"swarm-theme","version":1,"files":{"a":1}}')).toEqual({
      problem: expect.stringMatching(/no files/),
    });
  });
});
