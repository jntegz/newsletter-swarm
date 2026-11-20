// Starts the Setup Worker in the real Workers runtime and asks for its page. The unit tests can't
// catch a crash at start-up, because Vitest provides things a deployed Worker doesn't have, such
// as import.meta.url.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const child = spawn(
  'pnpm',
  ['exec', 'wrangler', 'dev', '--port', String(PORT), '--inspector-port', '9241'],
  {
    cwd: join(ROOT, 'apps/setup'),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  },
);
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));
let exited = false;
child.on('exit', () => (exited = true));

function stop() {
  try {
    if (process.platform === 'win32') child.kill();
    else process.kill(-child.pid);
  } catch {
    // Already gone.
  }
}

let ok = false;
for (let i = 0; i < 40 && !exited && !ok; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const response = await fetch(`http://localhost:${PORT}/`).catch(() => null);
  ok = response?.status === 200 && (await response.text()).includes('Swarm setup');
}
stop();
if (ok) {
  console.log('The Setup Worker starts in the Workers runtime.');
  process.exit(0);
}
console.error(`The Setup Worker did not start:\n${output.slice(-1500)}`);
process.exit(1);
