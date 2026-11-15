import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// A database-free browser fixture. Never starts Next, auth, workers, or providers.
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  define: { 'process.env': '{}' },
  resolve: { alias: { '@': `${root}/src` } },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { exclude: ['next/navigation', 'next/dynamic', 'next/link'], force: true },
  server: { host: '127.0.0.1', port: 3200, strictPort: true },
  plugins: [{
    name: 'isolated-next-shell',
    enforce: 'pre',
    resolveId(id) { if (['next/navigation', 'next/dynamic', 'next/link'].includes(id)) return `\0fixture:${id}`; },
    load(id) {
      if (id === '\0fixture:next/navigation') return 'export const useRouter = () => ({ push: () => {}, refresh: () => {} });';
      if (id === '\0fixture:next/dynamic') return 'import { lazy, createElement, Suspense } from "react"; export default (loader) => { const Component = lazy(loader); return props => createElement(Suspense, {fallback: null}, createElement(Component, props)); };';
      if (id === '\0fixture:next/link') return 'import { createElement } from "react"; export default ({children, ...props}) => createElement("a", props, children);';
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) { res.statusCode = 503; res.end('Fixture API must be mocked'); return; }
        next();
      });
    },
  }],
});
await server.listen();
console.log('Isolated design fixture: http://127.0.0.1:3200/tests/browser-fixtures/design.html');
