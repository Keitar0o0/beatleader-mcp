import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const config = JSON.parse(await readFile(new URL('../plugins/beatleader-mcp/.mcp.json', import.meta.url), 'utf8')).mcpServers.beatleader;
const client = new Client({ name: 'beatleader-smoke', version: '0.1.0' });
const http = process.argv[2] === '--http';
const transport = http ? new StreamableHTTPClientTransport(new URL(process.argv[3])) : new StdioClientTransport({ ...config, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);
  for (const tool of tools) assert.equal(tool.annotations.readOnlyHint, true);
  const invalid = await client.callTool({ name: 'get_player', arguments: { player: 'https://example.com/u/123' } });
  assert.equal(invalid.isError, true);
  const player = process.argv[http ? 4 : 2];
  if (player) {
    for (const [name, args] of [
      ['get_player', { player }],
      ['list_player_scores', { player, count: 2 }],
      ['get_player_history', { player, days: 3 }],
      ['summarize_player_scores', { player, maxPages: 1 }],
    ]) {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
      assert.ok(r.structuredContent);
      console.log(`${name}: OK`);
      if (name === 'list_player_scores') {
        const id = r.structuredContent.scores[0]?.leaderboardId;
        if (id) {
          const board = await client.callTool({ name: 'get_leaderboard', arguments: { id, count: 2 } });
          assert.ok(!board.isError, JSON.stringify(board.content));
          assert.equal(board.structuredContent.leaderboard.id, id);
          console.log('get_leaderboard: OK');
        }
      }
    }
  }
  assert.equal(stderr, '');
  console.log(player ? '公开 API 与 MCP 验证通过' : 'MCP 握手、工具注册、输入错误验证通过');
} finally {
  await client.close();
}
