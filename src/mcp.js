import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { schemas } from './schemas.js';
import { execute, descriptions } from './tools.js';

export function createServer(options = {}) {
const server = new McpServer({ name: 'beatleader-mcp', version: '0.1.0' });
for (const [name, inputSchema] of Object.entries(schemas)) {
  server.registerTool(name, {
    description: descriptions[name], inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const result = await execute(name, args, { ...options, signal: extra.signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        code: error.code ?? 'INVALID_INPUT', message: error.message, ...error.details,
      }) }] };
    }
  });
}
return server;
}
