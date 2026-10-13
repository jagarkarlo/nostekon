import { defineConfig } from 'astro/config';

export default defineConfig({
  server: {
    headers: { 'Content-Encoding': 'identity' },
  },
  vite: {
    plugins: [{
      name: 'nostekon-static-apps',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url || '/', 'http://localhost');
          if (url.pathname === '/docs' || url.pathname === '/demo') {
            response.writeHead(302, { Location: `${url.pathname}/${url.search}` });
            response.end();
            return;
          }
          if ((url.pathname.startsWith('/docs/') || url.pathname === '/demo/') && url.pathname.endsWith('/')) {
            request.url = `${url.pathname}index.html${url.search}`;
          }
          next();
        });
      },
    }],
  },
  redirects: Object.fromEntries([
    'start', 'levels', 'comparison',
    'guides/k3d-isolated-restore', 'guides/ci-recovery-gate', 'guides/metrics-and-dashboard',
    'concepts/how-it-works', 'concepts/write-ledger-rpo', 'concepts/isolated-restores',
    'reference/drill-spec', 'reference/drillrun-evidence',
  ].map((path) => [`/${path}/`, `/docs/${path}/`])),
});