import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

type Run = (file: string, args: string[]) => Promise<{ code: number; output: string }>;

const runFile: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() || (error?.message ?? '') });
    });
  });

/** The account icacls should grant, as Windows names it (DOMAIN\\user). */
function currentAccount(env: NodeJS.ProcessEnv): string {
  const { USERDOMAIN: domain, USERNAME: name } = env;
  if (domain && name) return `${domain}\\${name}`;
  return name || userInfo().username;
}

/**
 * On Windows file modes don't limit who can read a file, so this removes the access it inherited
 * from its folder and grants it to the current user alone: `icacls <file> /inheritance:r
 * /grant:r <user>:F`. Throws with icacls' message when that fails. Elsewhere it does nothing:
 * the file is already written with mode 0600.
 */
export function ownerOnly(
  platform: NodeJS.Platform = process.platform,
  run: Run = runFile,
  env: NodeJS.ProcessEnv = process.env,
): ((path: string) => Promise<void>) | undefined {
  if (platform !== 'win32') return undefined;
  return async (path) => {
    const result = await run('icacls', [
      path,
      '/inheritance:r',
      '/grant:r',
      `${currentAccount(env)}:F`,
    ]);
    if (result.code !== 0) throw new Error(`icacls exited ${result.code}: ${result.output}`);
  };
}
