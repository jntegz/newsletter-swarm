import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  lineProblems,
  messageProblems,
  readerProblems,
  stringLiterals,
  uppercaseProblem,
} from '../check-vocabulary.mjs';

describe('vocabulary rules', () => {
  it('rejects "tier" for a paid plan', () => {
    assert.deepEqual(lineProblems('Pick a paid tier'), ['"tier" → Paid plan']);
    assert.deepEqual(lineProblems('Tiers and prices'), ['"Tiers" → Paid plan']);
  });

  it('rejects the short-post feed called Notes', () => {
    assert.deepEqual(lineProblems('Share it to Notes'), ['"Notes" → Commons']);
    assert.deepEqual(lineProblems('Notes lets readers post'), ['"Notes" → Commons']);
  });

  it('leaves generic uses of note alone', () => {
    for (const line of [
      'Field Notes is a sample publication.',
      '| Queue | Producer | Notes |',
      "title: 'Notes on the popup economy'",
      'label="Note (optional)"',
      'release notes and notes for reviewers',
    ]) {
      assert.deepEqual(lineProblems(line), [], line);
    }
  });

  it('keeps the earlier rules and honours the allow marker', () => {
    assert.deepEqual(lineProblems('Start a campaign'), ['"campaign" → post or send']);
    assert.deepEqual(lineProblems('the tier column <!-- vocabulary-allow -->'), []);
  });

  it('reads string literals, not comments, expressions or regular expressions', () => {
    const source = [
      '// A Member comment',
      "const a = 'one two';",
      'const b = `<p>${member.name} is a reader</p>`;',
      'const c = /it\'s a "Member"/.test(a);',
      '/* Dispatch */ const d = "three";',
    ].join('\n');
    assert.deepEqual(stringLiterals(source), [
      { line: 2, text: 'one two' },
      { line: 3, text: '<p>' },
      { line: 3, text: ' is a reader</p>' },
      { line: 5, text: 'three' },
    ]);
  });

  it('rejects internal names in what readers see', () => {
    const problems = (source) => readerProblems(source).map((p) => p.problem.split(' (')[0]);
    assert.deepEqual(problems("const h = '<h1>Member Center</h1>';"), [
      '"Member Center" → Subscriber settings, or "Manage your subscription" on a link',
    ]);
    assert.deepEqual(problems('const t = `<p>This Dispatch is for paid Members.</p>`;'), [
      '"Dispatch" → post',
      '"Members" → subscriber',
    ]);
    assert.deepEqual(problems("fail(c, 'See Membership levels of this Channel');"), [
      '"Membership levels" → plan',
      '"Channel" → the publication',
    ]);
    assert.equal(readerProblems("\n\nconst g = 'Buy a Gift Pass';")[0].line, 3);
  });

  it('leaves code, keys, comments and plain wording alone', () => {
    for (const source of [
      "const kind: 'Member' | 'Dispatch' = 'Member';",
      '// Member Center links work for 30 days',
      'const sql = `SELECT id FROM members WHERE channel_id = ?1`;',
      'const page = `<p>${channel.name}</p><h1>Subscriber settings</h1>`;',
      "log.warn('member center billing failed');",
      "const ok = 'Ask the person who gave it to you';",
      "const old = 'This Dispatch is for paid Members'; // vocabulary-allow: a migration",
    ]) {
      assert.deepEqual(readerProblems(source), [], source);
    }
  });

  it('rejects internal names in the messages the dashboard shows', () => {
    const problems = (source) => messageProblems(source).map((p) => p.problem.split(' (')[0]);
    assert.deepEqual(problems("throw new ApiError('not_found', 'Dispatch not found.');"), [
      '"Dispatch" → post',
    ]);
    assert.deepEqual(
      problems("checks.push({ key: 'sender', ok: false, message: 'This Channel is paused.' });"),
      ['"Channel" → publication'],
    );
    assert.deepEqual(
      problems(
        'const check = {\n  message: ready\n    ? `Reputation Ramp is active.`\n    : `${n} Members wait.`,\n};',
      ),
      ['"Reputation Ramp" → warm-up', '"Members" → subscriber'],
    );
    assert.deepEqual(problems("throw invalid('levelId', 'Choose a Membership level.');"), [
      '"Membership level" → paid plan',
    ]);
    assert.deepEqual(problems("renderer.warnings.add('A Smart Block needs a condition.');"), [
      '"Smart Block" → Smart block',
    ]);
    assert.equal(
      messageProblems("\n\nthrow new StartError('wrong_status', 'A sent Dispatch.');")[0].line,
      3,
    );
  });

  it('leaves developer documentation, logs, SQL and internal errors alone', () => {
    for (const source of [
      "const route = createRoute({ summary: 'Create a Dispatch', description: 'Starts a Broadcast.' });",
      "const s = z.string().openapi({ description: 'The Channel the Member is in' });",
      "const m = z.object({ message: z.string().describe('What the Member sees') });",
      "log.warn('Broadcast halted for this Channel');",
      "throw new Error('Flow has no version for this Member');",
      "throw new ApiError('not_found', 'Post not found.');",
      "throw new ApiError('conflict', 'A Channel thing.'); // vocabulary-allow: quoted from a provider",
      'const sql = `SELECT message FROM flows WHERE name = ?1`;',
    ]) {
      assert.deepEqual(messageProblems(source), [], source);
    }
  });
});

describe('no uppercase micro labels', () => {
  it('rejects the uppercase class and text-transform in components', () => {
    for (const line of [
      '<tr className="text-[10.5px] tracking-[0.12em] text-sub uppercase">',
      "const HEADING = 'py-1.5 pr-3 uppercase';",
      'className={`${pad} uppercase`}',
      "style={{ textTransform: 'uppercase' }}",
    ]) {
      assert.ok(uppercaseProblem(line), line);
    }
  });

  it('leaves the sentence-case class, other words and comments alone', () => {
    for (const line of [
      '<tr className="table-head">',
      "const isUppercaseKey = (key) => key === 'A';",
      'onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}',
      '// Headers used to be uppercase; now they are sentence case.',
      ' * muted uppercase headers',
    ]) {
      assert.equal(uppercaseProblem(line), null, line);
    }
  });

  it('honours the marker on the line or the line before', () => {
    assert.equal(uppercaseProblem('className="uppercase" {/* uppercase-allow: code */}'), null);
    assert.equal(
      uppercaseProblem('className="font-mono uppercase"', '// uppercase-allow: currency code'),
      null,
    );
  });
});
