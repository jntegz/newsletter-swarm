// Serves the stand-in Turnstile widget (offline.mjs) over HTTPS on 127.0.0.1, where Chromium's
// host-resolver rule sends challenges.cloudflare.com (playwright.config.ts). The certificate is a
// throwaway self-signed one made for this run; the browser context ignores HTTPS errors.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteverify, WIDGET_SCRIPT } from './offline.mjs';

const port = Number(process.argv[2]);

const dir = mkdtempSync(join(tmpdir(), 'swarm-e2e-turnstile-'));
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
const key = join(dir, 'key.pem');
const cert = join(dir, 'cert.pem');
execFileSync('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '2',
  '-subj',
  '/CN=challenges.cloudflare.com',
  '-keyout',
  key,
  '-out',
  cert,
]);

const server = createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://challenges.cloudflare.com');
    if (req.method === 'GET' && url.pathname === '/turnstile/v0/api.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      });
      res.end(WIDGET_SCRIPT);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/turnstile/v0/siteverify') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const answer = siteverify(
        await new Request(url, {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] ?? '' },
          body: Buffer.concat(chunks),
        }).formData(),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(await answer.text());
      return;
    }
    res.writeHead(404).end();
  },
);
server.listen(port, '127.0.0.1', () => {
  console.log(`[e2e] stand-in Turnstile on https://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
