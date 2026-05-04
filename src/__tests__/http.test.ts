import http from 'http';
import { EventEmitter } from 'events';
import { request } from '../http';
import { ExeclaveError, ExeclaveAuthError } from '../errors';

// ---------------------------------------------------------------------------
// We mock Node's http.request to return controlled responses without a server.
// ---------------------------------------------------------------------------

jest.mock('http');

/**
 * Configure http.request mock to return a fake response.
 * Events are emitted *after* the callback attaches listeners.
 */
function setupMock(statusCode: number, body: string | object) {
  const req = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; destroy: jest.Mock };
  req.write = jest.fn();
  req.end = jest.fn();
  req.destroy = jest.fn();

  (http.request as jest.Mock).mockImplementation((_opts: any, callback: (r: any) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = statusCode;

    // Invoke the callback so the real code attaches `data`/`end` listeners
    process.nextTick(() => {
      callback(res);
      // Now emit data + end *after* listeners are attached
      process.nextTick(() => {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        res.emit('data', Buffer.from(raw));
        res.emit('end');
      });
    });

    return req;
  });

  return { req };
}

describe('HTTP request()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // Successful requests
  // ------------------------------------------------------------------
  describe('successful requests', () => {
    it('should resolve with status and parsed JSON data', async () => {
      setupMock(200, { ok: true });

      const resp = await request({
        method: 'GET',
        url: 'http://localhost:4000/api/health',
      });

      expect(resp.status).toBe(200);
      expect(resp.data).toEqual({ ok: true });
    });

    it('should send JSON body and Content-Length header', async () => {
      const { req } = setupMock(201, { data: { id: '1' } });

      await request({
        method: 'POST',
        url: 'http://localhost:4000/api/agents',
        body: { name: 'bot' },
      });

      expect(req.write).toHaveBeenCalledWith(JSON.stringify({ name: 'bot' }));
      expect(req.end).toHaveBeenCalled();
    });

    it('should include custom headers and User-Agent', async () => {
      setupMock(200, {});

      await request({
        method: 'GET',
        url: 'http://localhost:4000/api/test',
        headers: { Authorization: 'Bearer key123' },
      });

      const callArgs = (http.request as jest.Mock).mock.calls[0][0];
      expect(callArgs.headers['Authorization']).toBe('Bearer key123');
      expect(callArgs.headers['User-Agent']).toBe('execlave-js-sdk/1.0.0');
      expect(callArgs.headers['Content-Type']).toBe('application/json');
    });
    it('should default to port 80 for http URLs without explicit port', async () => {
      setupMock(200, { ok: true });

      await request({
        method: 'GET',
        url: 'http://example.com/api/health',
      });

      const callArgs = (http.request as jest.Mock).mock.calls[0][0];
      expect(callArgs.port).toBe(80);
    });
  });

  // ------------------------------------------------------------------
  // Error responses
  // ------------------------------------------------------------------
  describe('error responses', () => {
    it('should reject with ExeclaveAuthError on 401', async () => {
      setupMock(401, { error: { message: 'Unauthorized' } });

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/secret' }),
      ).rejects.toThrow(ExeclaveAuthError);
    });

    it('should reject with ExeclaveAuthError on 403', async () => {
      setupMock(403, { error: { message: 'Forbidden' } });

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/admin' }),
      ).rejects.toThrow(ExeclaveAuthError);
    });

    it('should reject with ExeclaveError on 400 with error message', async () => {
      setupMock(400, { error: { message: 'Validation failed' } });

      await expect(
        request({ method: 'POST', url: 'http://localhost:4000/api/agents', body: {} }),
      ).rejects.toThrow(/Validation failed/);
    });

    it('should reject with ExeclaveError on 500', async () => {
      setupMock(500, { error: { message: 'Internal server error' } });

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/boom' }),
      ).rejects.toThrow(ExeclaveError);
    });

    it('should handle string body in error response', async () => {
      setupMock(502, 'Bad Gateway');

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/gw' }),
      ).rejects.toThrow(/Bad Gateway/);
    });

    it('should include status code in error message for 4xx/5xx', async () => {
      setupMock(422, { error: { message: 'Unprocessable' } });

      await expect(
        request({ method: 'POST', url: 'http://localhost:4000/api/data' }),
      ).rejects.toThrow(/422/);
    });
  });

  // ------------------------------------------------------------------
  // Network errors
  // ------------------------------------------------------------------
  describe('network errors', () => {
    it('should reject with ExeclaveError on connection error', async () => {
      const req = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; destroy: jest.Mock };
      req.write = jest.fn();
      req.end = jest.fn();
      req.destroy = jest.fn();

      (http.request as jest.Mock).mockImplementation(() => {
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/health' }),
      ).rejects.toThrow(/Network error: ECONNREFUSED/);
    });

    it('should reject with timeout error and destroy request', async () => {
      const req = new EventEmitter() as EventEmitter & { write: jest.Mock; end: jest.Mock; destroy: jest.Mock };
      req.write = jest.fn();
      req.end = jest.fn();
      req.destroy = jest.fn();

      (http.request as jest.Mock).mockImplementation(() => {
        process.nextTick(() => req.emit('timeout'));
        return req;
      });

      await expect(
        request({ method: 'GET', url: 'http://localhost:4000/api/slow', timeout: 500 }),
      ).rejects.toThrow(/Request timed out/);
      expect(req.destroy).toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Non-JSON response
  // ------------------------------------------------------------------
  describe('non-JSON response', () => {
    it('should return raw string when response is not valid JSON', async () => {
      setupMock(200, 'plain text OK');

      const resp = await request({
        method: 'GET',
        url: 'http://localhost:4000/api/text',
      });

      expect(resp.status).toBe(200);
      expect(resp.data).toBe('plain text OK');
    });
  });
});
