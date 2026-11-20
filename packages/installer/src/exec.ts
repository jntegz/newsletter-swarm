import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Command = 'wrangler' | 'pnpm' | 'git';

interface ResolvedCommand {
  file: string;
  prefix: string[];
  shell: boolean;
}

// Only asked when running a program: the Setup Worker imports this file but has no path of its own.
const here = () => dirname(fileURLToPath(import.meta.url));

/** wrangler/bin/wrangler.js from the installer's own dependency, so the version is pinned. */
export function wranglerScript(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('wrangler/package.json');
    return join(dirname(pkg), 'bin', 'wrangler.js');
  } catch {
    return join(here(), '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  }
}

/**
 * How to start each tool without a shell. Node scripts run through process.execPath, which
 * works the same on Windows, macOS and Linux and never re-parses the arguments.
 */
export function resolveCommand(command: Command): ResolvedCommand {
  if (command === 'wrangler') {
    return { file: process.execPath, prefix: [wranglerScript()], shell: false };
  }
  if (command === 'pnpm') {
    // pnpm sets npm_execpath to its own entry script when it runs `pnpm swarm`.
    const execPath = process.env.npm_execpath;
    if (execPath && /\.(c|m)?js$/.test(execPath) && existsSync(execPath)) {
      return { file: process.execPath, prefix: [execPath], shell: false };
    }
    // pnpm.cmd can only start through a shell on Windows; the arguments are fixed strings.
    return { file: 'pnpm', prefix: [], shell: process.platform === 'win32' };
  }
  return { file: 'git', prefix: [], shell: false };
}

/** Wrangler's JSON output can be preceded by banner lines; take the first JSON value. */
export function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[[{]/);
    if (start === -1) throw new Error('no JSON in the output');
    return JSON.parse(trimmed.slice(start)) as T;
  }
}

/** The last lines of a failed command, for error messages. */
export function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}
