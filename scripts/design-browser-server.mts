import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';

// Controlled bytes for download characterization, not a production render.
const pdf = await PDFDocument.create();
const pdfPage = pdf.addPage([297 * 72 / 25.4, 210 * 72 / 25.4]);
pdfPage.drawText('Batch 0 controlled PDF transfer fixture', { x: 36, y: 540, size: 14 });
const pdfBytes = Buffer.from(await pdf.save());
const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
const reading = await PDFDocument.create();
for (let index = 0; index < 8; index++) reading.addPage([74 * 72 / 25.4, 105 * 72 / 25.4]).drawText(`Reading page ${index + 1}`, { x: 12, y: 240, size: 12 });
const readingBytes = Buffer.from(await reading.save());
const recovered = new Set<string>();

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
        const download = req.url?.match(/^\/api\/submissions\/download-fixture-([a-z-]+)\/downloads\?/);
        if (download) {
          const url = new URL(req.url!, 'http://127.0.0.1:3200');
          const mode = download[1];
          const kind = url.searchParams.get('kind');
          const content = kind === 'reading' ? readingBytes : pdfBytes;
          const status = mode === 'missing' ? 404 : mode === 'unauthenticated' ? 401 : mode === 'error' && !recovered.has(mode) ? 503 : 200;
          res.setHeader('Cache-Control', 'private, no-store');
          if (status !== 200) {
            res.statusCode = status;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            const message = status === 404 ? 'The stored PDF is missing.' : status === 401 ? 'Sign in to request this PDF.' : 'The PDF request could not be started. Please retry.';
            res.end(`<!doctype html><html lang="en"><title>PDF unavailable</title><main><h1>PDF unavailable</h1><p role="alert">${message}</p><a href="${url.pathname}?kind=${kind}">Retry PDF request</a><a href="/tests/browser-fixtures/design.html?pdfCase=${mode}">Back to fixture</a></main></html>`);
            return;
          }
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Length', content.length);
          const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
          res.setHeader('Content-Disposition', `${disposition}; filename="controlled-pdf-download-${kind === 'reading' ? 'reading-74x105mm' : 'print-sheet-a4-fold'}.pdf"`);
          if (mode === 'slow' || mode === 'interrupted') {
            res.write(content.subarray(0, 128));
            const timer = setTimeout(() => mode === 'interrupted' ? res.destroy() : res.end(content.subarray(128)), mode === 'slow' ? 2000 : 100);
            res.on('close', () => clearTimeout(timer));
          } else res.end(content);
          return;
        }
        if (req.url === '/fixtures/recover') { recovered.add('error'); res.end('Recovered fixture only'); return; }
        if (req.url === '/fixtures/reset') { recovered.clear(); res.end('Reset fixture only'); return; }
        if (req.url === '/fixtures/download-manifest') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ print: { bytes: pdfBytes.length, sha256: pdfSha256 }, reading: { bytes: readingBytes.length, sha256: createHash('sha256').update(readingBytes).digest('hex') } }));
          return;
        }
        if (req.url?.startsWith('/fixtures/baseline.pdf')) {
          const url = new URL(req.url, 'http://127.0.0.1:3200');
          const mode = url.searchParams.get('mode');
          if (mode === 'error') { res.statusCode = 503; res.end('Injected storage failure'); return; }
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="batch0-print.pdf"');
          res.setHeader('Content-Length', pdfBytes.length);
          res.setHeader('X-Fixture-SHA256', pdfSha256);
          res.setHeader('Cache-Control', 'no-store');
          if (mode === 'slow' || mode === 'interrupted') {
            res.write(pdfBytes.subarray(0, 128));
            const timer = setTimeout(() => {
              if (mode === 'interrupted') res.destroy();
              else res.end(pdfBytes.subarray(128));
            }, mode === 'slow' ? 2000 : 100);
            res.on('close', () => clearTimeout(timer));
          } else res.end(pdfBytes);
          return;
        }
        if (req.url === '/fixtures/baseline-manifest') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ bytes: pdfBytes.length, sha256: pdfSha256, pages: 1, widthMm: 297, heightMm: 210 }));
          return;
        }
        if (req.url?.startsWith('/api/')) { res.statusCode = 503; res.end('Fixture API must be mocked'); return; }
        next();
      });
    },
  }],
});
await server.listen();
console.log('Isolated design fixture: http://127.0.0.1:3200/tests/browser-fixtures/design.html');
