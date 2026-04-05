/**
 * Unit tests for HealthServer (src/health-server.js)
 *
 * handleRequest and getStatus are tested by calling them directly —
 * no live HTTP server needed. start/stop are tested with a mock server
 * to avoid port binding.
 */
const { HealthServer } = require('../../src/health-server');

// ─── getStatus() ─────────────────────────────────────────────────────────────

describe('HealthServer.getStatus()', () => {
  test('returns ok when redis.status === "ready"', () => {
    const server = new HealthServer({ redis: { status: 'ready' } });
    const s = server.getStatus();
    expect(s.status).toBe('ok');
    expect(s.redis).toBe('connected');
    expect(typeof s.uptime).toBe('number');
    expect(typeof s.timestamp).toBe('string');
  });

  test('returns degraded when redis.status is not "ready"', () => {
    const server = new HealthServer({ redis: { status: 'connecting' } });
    expect(server.getStatus().status).toBe('degraded');
    expect(server.getStatus().redis).toBe('disconnected');
  });

  test('returns degraded when no redis component provided', () => {
    const server = new HealthServer({});
    expect(server.getStatus().status).toBe('degraded');
  });

  test('returns degraded when redis component is null', () => {
    const server = new HealthServer({ redis: null });
    expect(server.getStatus().status).toBe('degraded');
  });
});

// ─── handleRequest() ─────────────────────────────────────────────────────────

function makeMockRes() {
  const res = {
    _status: null,
    _headers: {},
    _body: null,
    writeHead(status, headers) { this._status = status; this._headers = headers; },
    end(body) { this._body = body; }
  };
  return res;
}

describe('HealthServer.handleRequest()', () => {
  test('returns 200 with JSON body for GET /health when Redis ready', () => {
    const server = new HealthServer({ redis: { status: 'ready' } });
    const req = { method: 'GET', url: '/health' };
    const res = makeMockRes();

    server.handleRequest(req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res._body);
    expect(body.status).toBe('ok');
    expect(body.redis).toBe('connected');
  });

  test('returns 503 for GET /health when Redis is not ready', () => {
    const server = new HealthServer({ redis: { status: 'end' } });
    const req = { method: 'GET', url: '/health' };
    const res = makeMockRes();

    server.handleRequest(req, res);

    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.status).toBe('degraded');
  });

  test('returns 404 for unknown path', () => {
    const server = new HealthServer({});
    const res = makeMockRes();

    server.handleRequest({ method: 'GET', url: '/unknown' }, res);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toBe('Not Found');
  });

  test('returns 404 for non-GET method on /health', () => {
    const server = new HealthServer({ redis: { status: 'ready' } });
    const res = makeMockRes();

    server.handleRequest({ method: 'POST', url: '/health' }, res);

    expect(res._status).toBe(404);
  });

  test('sets Cache-Control: no-cache on successful response', () => {
    const server = new HealthServer({ redis: { status: 'ready' } });
    const res = makeMockRes();

    server.handleRequest({ method: 'GET', url: '/health' }, res);

    expect(res._headers['Cache-Control']).toBe('no-cache');
  });
});

// ─── start() / stop() ────────────────────────────────────────────────────────

describe('HealthServer.start() and stop()', () => {
  test('stop() does not throw when server was never started', () => {
    const server = new HealthServer({});
    expect(() => server.stop()).not.toThrow();
  });

  test('start() creates an http server and calls listen', () => {
    const http = require('http');

    const mockServer = {
      listen: vi.fn(),
      on: vi.fn(),
      close: vi.fn()
    };
    const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer);

    const server = new HealthServer({ redis: { status: 'ready' } });
    server.start();

    expect(createServerSpy).toHaveBeenCalledOnce();
    expect(mockServer.listen).toHaveBeenCalledWith(server.port, expect.any(Function));
    expect(mockServer.on).toHaveBeenCalledWith('error', expect.any(Function));

    createServerSpy.mockRestore();
  });

  test('stop() calls server.close() when server is running', () => {
    const http = require('http');
    const mockServer = { listen: vi.fn(), on: vi.fn(), close: vi.fn() };
    const spy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer);

    const server = new HealthServer({});
    server.start();
    server.stop();

    expect(mockServer.close).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
