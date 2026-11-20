import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CloudflareError, type CloudflareApi } from './cloudflare';
import { parseJsonOutput, tail } from './exec';
import type { Transport } from './transport';

export type Row = Record<string, unknown>;

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Runs SQL against the remote database. */
export interface D1Executor {
  /** One result set per statement. Several statements run as one atomic batch. */
  run(statements: Statement[]): Promise<{ results: Row[]; changes: number }[]>;
}

interface QueryResult {
  results?: Row[];
  success?: boolean;
  meta?: { changes?: number };
}

/** POST /accounts/{a}/d1/database/{id}/query with bound parameters. */
export class RestD1 implements D1Executor {
  constructor(
    private readonly cf: CloudflareApi,
    private readonly accountId: string,
    private readonly databaseId: string,
  ) {}

  async run(statements: Statement[]) {
    const path = `/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const body =
      statements.length === 1
        ? { sql: statements[0]!.sql, params: statements[0]!.params }
        : { batch: statements.map((s) => ({ sql: s.sql, params: s.params })) };
    const results = await this.cf.post<QueryResult[]>(path, body);
    return results.map((r) => ({ results: r.results ?? [], changes: r.meta?.changes ?? 0 }));
  }
}

/** A SQL literal, for the wrangler fallback, which cannot bind parameters. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Replaces ?1, ?2… (and bare ?) with literals. */
export function inlineParams(sql: string, params: unknown[]): string {
  let next = 0;
  return sql.replace(/\?(\d+)?/g, (_, index: string | undefined) =>
    sqlLiteral(params[index ? Number(index) - 1 : next++]),
  );
}

/** `wrangler d1 execute DB --remote --file`, used when the REST query endpoint refuses. */
export class WranglerD1 implements D1Executor {
  constructor(
    private readonly t: Transport,
    private readonly opts: { cwd: string; config: string; env: string; accountId: string },
  ) {}

  async run(statements: Statement[]) {
    const sql = statements
      .map((s) => `${inlineParams(s.sql, s.params).trim().replace(/;$/, '')};`)
      .join('\n');
    const file = join(tmpdir(), `swarm-d1-${randomBytes(6).toString('hex')}.sql`);
    await this.t.writeFile(file, sql, { secret: true });
    try {
      const result = await this.t.exec({
        command: 'wrangler',
        args: [
          'd1',
          'execute',
          'DB',
          '--remote',
          '--json',
          '--yes',
          '--config',
          this.opts.config,
          '--env',
          this.opts.env,
          '--file',
          file,
        ],
        cwd: this.opts.cwd,
        env: { CLOUDFLARE_ACCOUNT_ID: this.opts.accountId, CI: '1' },
      });
      if (result.code !== 0)
        throw new Error(`wrangler d1 execute failed:\n${tail(result.stderr || result.stdout)}`);
      const parsed = parseJsonOutput<QueryResult[] | QueryResult>(result.stdout || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return statements.map((_, i) => ({
        results: list[i]?.results ?? [],
        changes: list[i]?.meta?.changes ?? 0,
      }));
    } finally {
      await this.t.removeFile(file);
    }
  }
}

const SQL_ERROR = /SQLITE|constraint failed|no such (table|column)|syntax error/i;

/** REST first; on an auth or transport failure (not a SQL error), wrangler from then on. */
export class FallbackD1 implements D1Executor {
  private useFallback = false;
  constructor(
    private readonly primary: D1Executor,
    private readonly fallback: D1Executor,
    private readonly onSwitch: (reason: string) => void,
  ) {}

  async run(statements: Statement[]) {
    if (this.useFallback) return this.fallback.run(statements);
    try {
      return await this.primary.run(statements);
    } catch (error) {
      const message = (error as Error).message;
      if (SQL_ERROR.test(message) && !(error instanceof CloudflareError && error.forbidden))
        throw error;
      this.useFallback = true;
      this.onSwitch(message);
      return this.fallback.run(statements);
    }
  }
}

class Prepared {
  constructor(
    readonly db: D1Executor,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Prepared {
    return new Prepared(this.db, this.sql, values);
  }

  async all<T>() {
    const [result] = await this.db.run([{ sql: this.sql, params: this.params }]);
    return {
      results: (result?.results ?? []) as T[],
      success: true,
      meta: { changes: result?.changes ?? 0 },
    };
  }

  async first<T>(): Promise<T | null> {
    return ((await this.all<T>()).results[0] ?? null) as T | null;
  }

  run<T>() {
    return this.all<T>();
  }
}

/** A D1Database over an executor, so @swarm/db helpers (appendAudit) run unchanged. */
export function asD1Database(db: D1Executor): D1Database {
  return {
    prepare: (sql: string) => new Prepared(db, sql),
    async batch<T>(list: Prepared[]) {
      const results = await db.run(list.map((s) => ({ sql: s.sql, params: s.params })));
      return results.map((r) => ({
        results: r.results as T[],
        success: true,
        meta: { changes: r.changes },
      }));
    },
  } as unknown as D1Database;
}
