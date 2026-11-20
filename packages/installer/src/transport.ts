import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveCommand, type Command } from './exec';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export interface ExecRequest {
  command: Command;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Hand the terminal to the child (wrangler login). Output is not captured. */
  interactive?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type AwsService = 'sesv2' | 'sns' | 'iam' | 'sts';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AwsRequest {
  service: AwsService;
  /** The SDK command name without the "Command" suffix, e.g. "CreateTopic". */
  operation: string;
  input: Record<string, unknown>;
  region: string;
  credentials: AwsCredentials;
}

/**
 * Every side effect the installer has goes through this interface: processes, HTTP, AWS and file
 * writes outside .swarm/. --dry-run and the tests swap in FakeTransport (src/fake.ts), which
 * records each action and answers with made-up ids.
 */
export interface Transport {
  readonly dryRun: boolean;
  http(request: HttpRequest): Promise<HttpResponse>;
  exec(request: ExecRequest): Promise<ExecResult>;
  aws<T = Record<string, unknown>>(request: AwsRequest): Promise<T>;
  writeFile(path: string, content: string, options?: { secret?: boolean }): Promise<void>;
  /** Reads a file the installer wrote (null when missing); the fake reads its own writes. */
  readFile(path: string): Promise<string | null>;
  removeFile(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const SDK_CLIENTS: Record<AwsService, { module: string; client: string }> = {
  sesv2: { module: '@aws-sdk/client-sesv2', client: 'SESv2Client' },
  sns: { module: '@aws-sdk/client-sns', client: 'SNSClient' },
  iam: { module: '@aws-sdk/client-iam', client: 'IAMClient' },
  sts: { module: '@aws-sdk/client-sts', client: 'STSClient' },
};

type SdkModule = Record<string, unknown>;
interface SdkClient {
  send(command: unknown): Promise<unknown>;
}

export class RealTransport implements Transport {
  readonly dryRun = false;

  async http(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers ?? {},
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, text: await response.text() };
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    const { file, prefix, shell } = resolveCommand(request.command);
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...prefix, ...request.args], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        shell,
        windowsHide: true,
        stdio: request.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  async aws<T>(request: AwsRequest): Promise<T> {
    const spec = SDK_CLIENTS[request.service];
    const sdk = (await import(spec.module)) as SdkModule;
    const Client = sdk[spec.client] as new (config: unknown) => SdkClient;
    const Command = sdk[`${request.operation}Command`] as
      (new (input: unknown) => unknown) | undefined;
    if (!Command) throw new Error(`unknown AWS operation ${request.service}:${request.operation}`);
    const client = new Client({ region: request.region, credentials: request.credentials });
    return (await client.send(new Command(request.input))) as T;
  }

  async writeFile(path: string, content: string, options?: { secret?: boolean }) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: 'utf8', mode: options?.secret ? 0o600 : 0o644 });
  }

  async readFile(path: string) {
    return existsSync(path) ? readFile(path, 'utf8') : null;
  }

  async removeFile(path: string) {
    await rm(path, { force: true });
  }

  sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
