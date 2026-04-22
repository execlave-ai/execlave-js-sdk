/**
 * Minimal HTTP client using Node.js built-in `http`/`https`.
 * Zero runtime dependencies.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { ExeclaveAuthError, ExeclaveError } from './errors';

interface RequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  /** When true, resolve (don't reject) on 4xx responses so callers can inspect the body. */
  resolveOnClientError?: boolean;
}

interface HttpResponse {
  status: number;
  data: any;
}

export async function request(opts: RequestOptions): Promise<HttpResponse> {
  const { method, url, headers = {}, body, timeout = 30_000, resolveOnClientError = false } = opts;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'execlave-js-sdk/1.0.0',
      ...headers,
    };

    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }

          const status = res.statusCode ?? 0;

          if (!resolveOnClientError) {
            if (status === 401 || status === 403) {
              return reject(new ExeclaveAuthError());
            }

            if (status >= 400) {
              let msg = `API request failed (${status})`;
              if (data?.error?.message) {
                msg += `: ${data.error.message}`;
              } else if (typeof data === 'string') {
                msg += `: ${data.slice(0, 200)}`;
              }
              return reject(new ExeclaveError(msg));
            }
          }

          resolve({ status, data });
        });
      }
    );

    req.on('error', (err) => reject(new ExeclaveError(`Network error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new ExeclaveError('Request timed out'));
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}
