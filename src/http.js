import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createServer } from './mcp.js';

export function httpConfig(env = process.env) {
  const vercelHosts = [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
  const publicHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  return {
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? env.BEATLEADER_HTTP_PORT ?? 3000),
    host: z.enum(['127.0.0.1', '0.0.0.0']).parse(env.BEATLEADER_HTTP_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1')),
    publicUrl: env.BEATLEADER_PUBLIC_URL || (publicHost ? 'https://' + publicHost : undefined),
    allowedHosts: vercelHosts,
  };
}

export function createHttpApp({ publicUrl, allowedHosts = [] } = {}) {
  let publicOrigin;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('BEATLEADER_PUBLIC_URL must be an HTTPS origin, such as https://example.com');
    }
    publicOrigin = url.origin;
  }
  const hosts = [...new Set(['127.0.0.1', 'localhost', ...allowedHosts, ...(publicOrigin ? [new URL(publicOrigin).hostname] : [])])];
  const app = createMcpExpressApp({ allowedHosts: hosts });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== publicOrigin) return res.status(403).json({ error: 'Origin rejected' });
    next();
  });
  app.get(['/', '/health'], (_req, res) => res.json({ service: 'BeatLeader Helper', status: 'ok', endpoint: '/mcp' }));
  app.post('/mcp', async (req, res) => {
    // The shared HTTP endpoint requires an explicit player; personal defaults belong to stdio
    const server = createServer({ defaultPlayer: '' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(error => console.error(error.message)); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP HTTP request failed:', error.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      else if (!res.writableEnded) res.end();
      await server.close();
    }
  });
  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST for stateless MCP' }, id: null });
  });
  app.use((error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Request too large' : 'Invalid request body' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = httpConfig();
  const listener = createHttpApp(config).listen(config.port, config.host, () => {
    console.log(`BeatLeader Helper HTTP MCP: http://${config.host}:${config.port}/mcp`);
  });
  listener.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    listener.close();
    listener.closeAllConnections();
  });
}
