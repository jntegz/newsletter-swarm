/** The vault's bindings and vars as wrangler gives them; src/index.ts validates them per call. */
interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  [name: string]: unknown;
}
