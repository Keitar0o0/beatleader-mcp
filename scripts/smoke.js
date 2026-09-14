import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'beatleader-smoke', version: '0.1.0' });
const http = process.argv[2] === '--http';
const transport = http ? new StreamableHTTPClientTransport(new URL(process.argv[3])) : new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))], stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk; });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['analyze_player', 'get_leaderboard', 'get_player', 'get_player_history', 'list_player_scores', 'search_maps', 'search_players']);
  for (const tool of tools) assert.equal(tool.annotations.readOnlyHint, true);
  const invalid = await client.callTool({ name: 'get_player', arguments: { player: 'https://example.com/u/123' } });
  assert.equal(invalid.isError, true);
  const player = process.argv[http ? 4 : 2];
  if (player) {
    for (const [name, args] of [
      ['get_player', { player, include: ['stats', 'clans', 'socials', 'badges'] }],
      ['search_players', { count: 2 }],
      ['search_maps', { count: 2, starsFrom: 4, starsTo: 8 }],
      ['list_player_scores', { player, count: 2 }],
      ['get_player_history', { player, days: 3 }],
      ['analyze_player', { player, maxPages: 1 }],
    ]) {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
      assert.ok(r.structuredContent);
      assert.ok(r.structuredContent.sources.length);
      assert.ok(r.structuredContent.data);
      console.log(`${name}: OK`);
      if (name === 'list_player_scores') {
        const id = r.structuredContent.data[0]?.leaderboardId;
        if (id) {
          const board = await client.callTool({ name: 'get_leaderboard', arguments: { id, count: 2 } });
          assert.ok(!board.isError, JSON.stringify(board.content));
          assert.equal(board.structuredContent.data.id, id);
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
