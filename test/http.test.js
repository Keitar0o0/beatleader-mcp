import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
function withHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp, httpConfig } from '../src/http.js';

test('HTTP 工具发现、并行客户端、输入校验与请求边界', async () => {
  const server = createHttpApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = new URL('http://127.0.0.1:' + server.address().port + '/mcp');
  const clients = [1, 2].map(i => new Client({ name: 'test-' + i, version: '1.0.0' }));
  try {
    await Promise.all(clients.map(c => c.connect(new StreamableHTTPClientTransport(url))));
    for (const c of clients) {
      const result = await c.listTools();
      assert.deepEqual(result.tools.map(t => t.name).sort(), ['analyze_player', 'get_leaderboard', 'get_player', 'get_player_history', 'list_player_scores', 'search_maps', 'search_players']);
      assert.ok(result.tools.every(t => t.annotations.readOnlyHint && t.inputSchema));
      const invalid = await c.callTool({ name: 'get_player', arguments: { player: '../123' } });
      assert.equal(invalid.isError, true);
      const missing = await c.callTool({ name: 'get_player', arguments: {} });
      assert.equal(missing.isError, true);
    }
    assert.deepEqual(await (await fetch(new URL('/', url))).json(), { service: 'BeatLeader Helper', status: 'ok', endpoint: '/mcp' });
    assert.equal((await fetch(new URL('/health', url))).status, 200);
    for (const method of ['GET', 'DELETE', 'PUT']) assert.equal((await fetch(url, { method })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal(await withHeaders(url, { Host: 'evil.example' }), 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(110000) }) })).status, 413);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test('隧道域名须显式配置', async () => {
  for (const publicUrl of ['http://example.com', 'https://u:p@example.com', 'https://example.com/mcp', 'https://example.com/?x=1']) {
    assert.throws(() => createHttpApp({ publicUrl }));
  }
  const server = createHttpApp({ publicUrl: 'https://mcp.example.com' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(await withHeaders('http://127.0.0.1:' + server.address().port + '/health', { Host: 'mcp.example.com', Origin: 'https://mcp.example.com' }), 200);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test('本机 HTTP 配置', () => {
  assert.deepEqual(httpConfig({}), { port: 3000, host: '127.0.0.1', publicUrl: undefined, allowedHosts: [] });
  const config = httpConfig({ PORT: '8080', BEATLEADER_HTTP_PORT: '3001' });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '0.0.0.0');
  assert.throws(() => httpConfig({ PORT: 'bad' }));
  assert.throws(() => httpConfig({ PORT: '0' }));
});

test('Vercel 预览与生产域名', async () => {
  const config = httpConfig({ VERCEL_URL: 'preview.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'mcp.example.com' });
  assert.equal(config.publicUrl, 'https://mcp.example.com');
  assert.deepEqual(config.allowedHosts, ['preview.vercel.app', 'mcp.example.com']);
  assert.equal(httpConfig({ BEATLEADER_PUBLIC_URL: 'https://custom.example', VERCEL_URL: 'preview.vercel.app' }).publicUrl, 'https://custom.example');
  const server = createHttpApp(config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal(await withHeaders(base + '/health', { Host: 'preview.vercel.app' }), 200);
    assert.equal(await withHeaders(base + '/health', { Host: 'mcp.example.com', Origin: 'https://mcp.example.com' }), 200);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
