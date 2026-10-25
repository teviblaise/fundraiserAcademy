import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBackend } from './backend.mjs';
import { applyNetworkHeaders } from './network-security.mjs';

const root = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
// Render supplies the public HTTPS origin after allocating the service URL.
// An explicit APP_ORIGIN remains the override for a custom domain.
if (!process.env.APP_ORIGIN && process.env.RENDER_EXTERNAL_URL) {
  process.env.APP_ORIGIN = new URL(process.env.RENDER_EXTERNAL_URL).origin;
}
const backend = createBackend(process.env.DATABASE_PATH || fileURLToPath(new URL('./data/academy.sqlite', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer(async (req, res) => {
  applyNetworkHeaders(res, { appOrigin: process.env.APP_ORIGIN });
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (/^\/api\/contracts\/[a-f0-9-]{36}\/document$/.test(pathname)) {
      applyNetworkHeaders(res, { appOrigin: process.env.APP_ORIGIN, sameOriginFrame: true });
    }
    if (pathname === '/healthz' && req.method === 'GET') {
      const health=backend.health();
      res.writeHead(health.status==='ok'?200:503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(health)); return;
    }
    if (pathname.startsWith('/api/')) { await backend.handle(req,res,pathname); return; }
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const resolved = await realpath(filename);
    if (!resolved.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const body = await readFile(resolved);
    const recoveryPage = ['/forgot-password.html', '/reset-password.html', '/security.html', '/login.html', '/admin.html', '/account-tools.html', '/performance.html'].includes(pathname);
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...(pathname==='/sw.js'?{'Cache-Control':'no-cache'}:{}), ...(recoveryPage ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } : {}) });
    res.end(body);
  } catch (error) {
    const expected=['ENOENT','ENOTDIR'].includes(error.code)||error instanceof URIError;
    if(!expected)backend.capture(error,{route:'/static',method:req.method,status:500});
    if(res.headersSent){res.destroy();return;}
    res.writeHead(expected?404:500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(expected?'Not found':'Server error. Please try again.');
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Fundraiser Academy listening on port ' + (process.env.PORT || 3000)));
