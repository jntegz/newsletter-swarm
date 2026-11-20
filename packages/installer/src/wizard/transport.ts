import type { AwsRequest, ExecResult, HttpRequest, HttpResponse, Transport } from '../transport';
import { InstallError } from '../ui';
import { callAws } from './aws';

const notHere = (what: string) =>
  new InstallError(
    `${what} isn't available in the browser setup.`,
    'Use the terminal installer (`pnpm swarm`) for this.',
  );

/** The side effects a Worker has: HTTP only. No processes and no local files. */
export class WorkerTransport implements Transport {
  readonly dryRun = false;

  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async http(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers ?? {},
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return { status: response.status, text: await response.text() };
  }

  async exec(): Promise<ExecResult> {
    throw notHere('Running a program');
  }

  aws<T>(request: AwsRequest): Promise<T> {
    return callAws<T>(request, this.fetcher, (ms) => this.sleep(ms));
  }

  async writeFile(): Promise<void> {}

  async readFile(): Promise<string | null> {
    return null;
  }

  async removeFile(): Promise<void> {}

  sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
