import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const GOOGLE_STATS_ENDPOINT =
  process.env.GOOGLE_STATS_ENDPOINT ||
  'https://script.google.com/macros/s/AKfycbwahqGocPhBwCTaB2HjnM3WIjoTOoc-lk94i8JjkRaTfEXf-rT-OXe0pkpQkZk5u0Tm/exec';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value, null, 2));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(message);
}

async function proxyGoogleStats(req, res) {
  if (!GOOGLE_STATS_ENDPOINT) {
    sendJson(res, 500, { ok: false, error: 'GOOGLE_STATS_ENDPOINT is not configured.' });
    return;
  }

  try {
    const upstream = await fetch(GOOGLE_STATS_ENDPOINT, {
      headers: {
        accept: 'application/json',
        'user-agent': 'vball-local-server/1.0',
      },
      cache: 'no-store',
    });

    const body = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(Buffer.from(body));
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: `Unable to reach Google Drive stats endpoint: ${error.message}`,
    });
  }
}

function resolveStaticPath(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname);
  const cleanPath = decodedPath === '/' ? '/stats.html' : decodedPath;
  const normalizedRelativePath = normalize(cleanPath).replace(/^([/\\])+/, '');
  const absolutePath = resolve(join(ROOT_DIR, normalizedRelativePath));
  const rootPath = resolve(ROOT_DIR);

  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${sep}`)) {
    return null;
  }

  return absolutePath;
}

async function serveStatic(req, res, pathname) {
  const filePath = resolveStaticPath(pathname);

  if (!filePath) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (!fileStat.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const extension = extname(filePath);
  const contentType =
    filePath.endsWith(`${sep}default_database`)
      ? 'application/json; charset=utf-8'
      : MIME_TYPES.get(extension) || 'application/octet-stream';

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': fileStat.size,
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      root: ROOT_DIR,
      googleStatsEndpoint: GOOGLE_STATS_ENDPOINT,
    });
    return;
  }

  if (url.pathname === '/api/google-stats') {
    await proxyGoogleStats(req, res);
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Volleyball local server: http://${HOST}:${PORT}/`);
  console.log(`Google stats proxy: http://${HOST}:${PORT}/api/google-stats`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
