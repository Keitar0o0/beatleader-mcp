import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const config = { mcpServers: { beatleader: {
  command: process.execPath,
  args: [fileURLToPath(new URL('src/server.js', root))],
} } };
await writeFile(new URL('plugins/beatleader-mcp/.mcp.json', root), `${JSON.stringify(config, null, 2)}\n`);
console.log('已配置当前 Node 与项目的绝对路径');
