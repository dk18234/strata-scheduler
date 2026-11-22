import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QueueStore, DEFAULT_STORE, type StoreConfig } from './store.js';
import { InputError } from './core/model.js';
export function startServer(options: {
  token: string;
  dbPath?: string;
  port?: number;
  host?: string;
  config?: StoreConfig;
  staticDir?: string;
}) {
  if (typeof options.token !== 'string' || options.token.length < 24)
    throw new InputError('ADMIN_TOKEN must contain at least 24 characters');
  const store = new QueueStore(options.dbPath ?? 'data/strata.db', options.config ?? DEFAULT_STORE),
    root = resolve(options.staticDir ?? 'docs');
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  };
  const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > 131072) throw new InputError('Request body exceeds 128 KiB', 'INPUT_LIMIT', 413);
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new InputError('Expected JSON body');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new InputError('Expected a JSON object');
    return value as Record<string, unknown>;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/health') {
        send(res, 200, { status: 'UP' });
        return;
      }
      if (path.startsWith('/api/')) {
        const supplied = Buffer.from(String(req.headers['x-admin-token'] ?? '')),
          expected = Buffer.from(options.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          send(res, 401, { code: 'UNAUTHORIZED', message: 'A valid operator token is required' });
          return;
        }
        if (path === '/api/snapshot' && req.method === 'GET') {
          send(res, 200, store.snapshot());
          return;
        }
        if (path === '/api/jobs' && req.method === 'POST') {
          const value = await body(req),
            jobs = Array.isArray(value.jobs) ? value.jobs : [value];
          const key = String(req.headers['idempotency-key'] ?? '');
          const result = store.submit(jobs, key);
          send(res, result.duplicate ? 200 : 201, result);
          return;
        }
        if (path === '/api/workers/claim' && req.method === 'POST') {
          const value = await body(req);
          if (typeof value.worker !== 'string') throw new InputError('Provide worker ID');
          send(res, 200, store.claim(value.worker));
          return;
        }
        const match = /^\/api\/jobs\/([A-Za-z0-9_-]{1,80})\/(heartbeat|complete|cancel)$/.exec(
          path,
        );
        if (match && req.method === 'POST') {
          const value = await body(req),
            id = match[1]!,
            action = match[2];
          if (action === 'cancel') {
            send(res, 200, store.cancel(id));
            return;
          }
          if (typeof value.token !== 'string' || value.token.length > 200)
            throw new InputError('Provide attempt token');
          if (action === 'heartbeat') {
            send(res, 200, store.heartbeat(id, value.token));
            return;
          }
          if (typeof value.result !== 'string') throw new InputError('Provide workload result');
          send(res, 200, store.complete(id, value.token, value.result));
          return;
        }
        send(res, 404, { code: 'NOT_FOUND', message: 'Unknown API route or method' });
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        send(res, 405, { code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        throw new InputError('Invalid URL encoding');
      }
      const file = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!file.startsWith(root + '/')) {
        send(res, 404, { code: 'NOT_FOUND' });
        return;
      }
      const bytes = await readFile(file).catch(() => undefined);
      if (!bytes) {
        send(res, 404, { code: 'NOT_FOUND' });
        return;
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.json': 'application/json; charset=utf-8',
        '.jpg': 'image/jpeg',
      };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof InputError)
        send(res, error.status, { code: error.code, message: error.message });
      else
        send(res, 500, {
          code: 'SERVICE_ERROR',
          message: 'Queue operation could not be completed',
        });
    }
  });
  const sweep = setInterval(() => {
    try {
      store.recover();
    } catch {
      /* A busy database is retried by the next sweep; committed state is unchanged. */
    }
  }, 200);
  sweep.unref();
  server.on('close', () => {
    clearInterval(sweep);
    store.close();
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(options.port ?? 8086, options.host ?? '127.0.0.1');
  return { server, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = startServer({
    token: process.env.ADMIN_TOKEN ?? '',
    dbPath: process.env.DB_PATH ?? 'data/strata.db',
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8086),
  });
  server.on('listening', () => {
    const address = server.address();
    console.log(
      JSON.stringify({
        event: 'READY',
        port: address && typeof address === 'object' ? address.port : 8086,
      }),
    );
  });
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
