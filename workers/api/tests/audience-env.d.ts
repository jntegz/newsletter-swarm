// Bindings the Phase 3 Members tests use, on top of env.d.ts.
declare global {
  /** Vite's import.meta.glob (tests/vault.test.ts reads the sources with it). */
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, unknown>;
  }
  namespace Cloudflare {
    interface Env {
      IMPORTS: R2Bucket;
      EXPORTS: R2Bucket;
    }
  }
}

export {};
