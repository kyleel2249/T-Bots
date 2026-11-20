// scripts/serve.mjs - zero-dependency static server (Windows, macOS, Linux). Usage: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error('forbidden'), { code: 403 });
    if (!(await stat(file)).isFile()) throw Object.assign(new Error('nf'), { code: 404 });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(e.code === 403 ? 403 : 404, { 'content-type': 'text/plain' });
    res.end(e.code === 403 ? 'Forbidden' : 'Not found');
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Try: node scripts/serve.mjs ${port + 1}` : e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Grok Bot running at ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
});
