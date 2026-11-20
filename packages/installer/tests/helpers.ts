import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Answers } from '../src/answers';
import { createContext, parseArgs } from '../src/cli';
import { FakeTransport, type FakeOptions } from '../src/fake';
import { MemoryStateStore } from '../src/state';
import { consoleUi, noPrompter } from '../src/ui';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export async function answers(overrides: Partial<Answers> = {}): Promise<Answers> {
  const base = JSON.parse(await readFile(fixture('answers.json'), 'utf8')) as Answers;
  return { ...base, ...overrides };
}

/** A run against the fake world, with no output. */
export async function fakeRun(opts: {
  argv?: string[];
  answers?: Answers;
  store?: MemoryStateStore;
  transport?: FakeTransport;
  fake?: FakeOptions;
  output?: string[];
}) {
  const options = parseArgs(opts.argv ?? ['--dry-run']);
  const transport =
    opts.transport ??
    new FakeTransport({ zone: 'example.com', environment: options.env, ...opts.fake });
  const store = opts.store ?? new MemoryStateStore();
  const output = opts.output ?? [];
  const ctx = await createContext({
    options,
    transport,
    store,
    ui: consoleUi(noPrompter, (s) => output.push(s)),
    answers: opts.answers ?? (await answers()),
  });
  return { ctx, transport, store, output };
}
