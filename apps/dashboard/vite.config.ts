import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Development only, for ?mock=1 (src/dev/mockApi.ts): the mock media library's uploaded font is one
 * of the repository's own font files, served at /media/mock/<file> like a real upload is at
 * /media/<key>, so the studio and its preview load it from the same kind of address.
 */
function mockMedia(): Plugin {
  const fonts = new URL('../../design/2026-11/fonts/', import.meta.url).pathname;
  return {
    name: 'swarm-mock-media',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const file = /^\/media\/mock\/([a-z0-9-]+\.woff2)$/.exec(req.url ?? '')?.[1];
        if (file) req.url = `/@fs${fonts}${file}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mockMedia()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
      '/healthz': 'http://localhost:8787',
      '/v2': 'http://localhost:8787',
      '/.well-known/api-catalog': 'http://localhost:8787',
      '/__dev': 'http://localhost:8787',
      // OAuth protocol endpoints; /oauth/consent is a dashboard page.
      '/oauth/authorize': 'http://localhost:8787',
      '/oauth/token': 'http://localhost:8787',
      '/oauth/revoke': 'http://localhost:8787',
      '/.well-known/oauth-authorization-server': 'http://localhost:8787',
    },
  },
});
