// The installer imports @swarm/db and @swarm/tokens, whose sources are typed against the Workers
// runtime. These are the few shapes they use, so the installer can typecheck under Node types.
// src/d1.ts implements D1Database over the Cloudflare D1 REST API.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;

  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: { changes: number; [key: string]: unknown };
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  }
}

export {};
