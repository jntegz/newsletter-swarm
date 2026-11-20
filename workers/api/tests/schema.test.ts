import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// The whole schema after every migration in migrations/, as D1 applies them (tests/setup.ts):
// tables with each column's type, nullability, default and key position, CHECK constraints,
// foreign keys, indexes, triggers and views. A migration that adds, drops or changes any of these
// changes tests/schema.snapshot.txt, so it shows up in review. Regenerate with
// `pnpm --filter @swarm/api exec vitest run tests/schema.test.ts -u`.

type Column = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};
type ForeignKey = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
};
type IndexEntry = { name: string; unique: number; origin: string; partial: number };
type IndexColumn = { seqno: number; name: string | null };

const INTERNAL = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'";

async function rows<T>(sql: string): Promise<T[]> {
  return (await env.DB.prepare(sql).all<T>()).results;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The CHECK constraints in a CREATE TABLE statement, each with its balanced parentheses. */
function checks(sql: string): string[] {
  const found: string[] = [];
  for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < sql.length; end++) {
      if (sql[end] === '(') depth++;
      else if (sql[end] === ')' && --depth === 0) break;
    }
    found.push(sql.slice(match.index, end + 1).replace(/\s+/g, ' '));
  }
  return found;
}

async function describeSchema(): Promise<string> {
  const out: string[] = [];
  const tables = await rows<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${INTERNAL} ORDER BY name`,
  );
  for (const table of tables) {
    const virtual = /^CREATE VIRTUAL TABLE/i.test(table.sql);
    out.push(`table ${table.name}${virtual ? ` (${table.sql.replace(/\s+/g, ' ')})` : ''}`);
    const columns = await rows<Column>(`PRAGMA table_xinfo(${quote(table.name)})`);
    for (const c of columns) {
      const parts = [`  ${c.name}`, c.type || '(no type)'];
      if (c.notnull) parts.push('NOT NULL');
      if (c.dflt_value !== null) parts.push(`DEFAULT ${c.dflt_value}`);
      if (c.pk) parts.push(`PK${c.pk}`);
      if (c.hidden === 2 || c.hidden === 3) parts.push('GENERATED');
      else if (c.hidden === 1) parts.push('HIDDEN');
      out.push(parts.join(' '));
    }
    if (virtual) continue;
    for (const check of checks(table.sql)) out.push(`  ${check}`);
    const keys = await rows<ForeignKey>(`PRAGMA foreign_key_list(${quote(table.name)})`);
    for (const k of keys.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      out.push(
        `  fk ${k.from} -> ${k.table}(${k.to ?? 'pk'}) on delete ${k.on_delete.toLowerCase()} on update ${k.on_update.toLowerCase()}`,
      );
    }
    const indexes = await rows<IndexEntry>(`PRAGMA index_list(${quote(table.name)})`);
    for (const index of indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const cols = await rows<IndexColumn>(`PRAGMA index_info(${quote(index.name)})`);
      const names = cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name ?? '<expr>');
      // Autoindexes are named by position; name them by what they cover instead.
      const label = index.name.startsWith('sqlite_autoindex_') ? `(${index.origin})` : index.name;
      out.push(
        `  index ${label}${index.unique ? ' UNIQUE' : ''}${index.partial ? ' PARTIAL' : ''} (${names.join(', ')})`,
      );
    }
  }
  // Index, trigger and view definitions as written, so expressions and WHERE clauses are covered.
  const objects = await rows<{ type: string; name: string; sql: string }>(
    `SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL AND ${INTERNAL} ORDER BY type, name`,
  );
  for (const o of objects) out.push(`${o.type} ${o.name}: ${o.sql.replace(/\s+/g, ' ').trim()}`);
  return `${out.join('\n')}\n`;
}

describe('schema', () => {
  it('matches the committed snapshot after all migrations', async () => {
    await expect(await describeSchema()).toMatchFileSnapshot('./schema.snapshot.txt');
  });
});
