# 开发与排查

安装和使用方式见 [README](../README.zh-CN.md)

## 运行入口

服务使用官方 MCP TypeScript SDK 与 Zod，HTTP 请求使用 Node 内置 `fetch`，测试使用 Node 内置测试运行器

| 命令 | 用途 |
|---|---|
| `pnpm start` | 启动 stdio MCP |
| `pnpm start:http` | 启动本机 HTTP MCP |
| `pnpm test` | 运行逻辑与 HTTP 集成测试 |
| `node scripts/smoke.js --http <URL>` | 验证 HTTP MCP 握手与工具发现 |

Vercel 通过根目录 `index.js` 导出 Express 应用，本机 HTTP 默认监听 `http://127.0.0.1:3000`

| 路径 | 方法 | 用途 |
|---|---|---|
| `/` | GET | 显示服务名、状态与 MCP 路径 |
| `/health` | GET | 健康检查 |
| `/mcp` | POST | Streamable HTTP MCP，每次请求独立 |

## 环境变量

| 变量 | 用途 |
|---|---|
| `BEATLEADER_PLAYER_ID` | stdio 默认玩家 |
| `BEATLEADER_HTTP_PORT` | 本机 HTTP 端口，默认 3000 |
| `PORT` | 平台端口，优先于本机端口 |
| `BEATLEADER_HTTP_HOST` | 本机监听地址，可选 `127.0.0.1` 或 `0.0.0.0` |
| `BEATLEADER_PUBLIC_URL` | 额外自定义域名的 HTTPS Origin，用于 Host 与 Origin 校验 |
| `VERCEL_URL` | Vercel 当前部署域名，自动加入 Host 白名单 |
| `VERCEL_PROJECT_PRODUCTION_URL` | Vercel 项目生产域名，自动加入 Host 白名单并作为默认公开 Origin |

HTTP 模式要求显式 `player` 参数；时间筛选使用带时区的 ISO 字符串，例如 `2026-09-01T00:00:00+08:00`

## 代码职责

| 文件 | 职责 |
|---|---|
| `src/schemas.js` | 输入校验与 BeatLeader 查询参数 |
| `src/api.js` | 上游限制、超时、重试、响应校验与数据精简 |
| `src/analysis.js` | 确定性统计与练习候选筛选 |
| `src/tools.js` | 工具查询流程、覆盖范围与返回说明 |
| `src/mcp.js` | 共用工具注册 |
| `src/server.js` | stdio 入口 |
| `src/http.js` | HTTP 路由、监听配置与请求边界 |
| `index.js` | Vercel Express Function 入口 |
| `scripts/configure.js` | 生成本机 stdio 插件配置 |
| `scripts/smoke.js` | stdio 或 HTTP MCP 验证 |

数据按调用实时获取，练前基线沿用当前对话

## 数据与分析约定

- `accuracy` 原始值为 0～1 比例，`medianAccuracyPercent` 为百分比，`gapPercentagePoints` 为百分点
- 成绩按模式、难度、评级状态、修改器和两星基础评级区间分组
- 同组有效准确率成绩达到 5 条后，以其余成绩的中位数计算差距，达到 0.5 个百分点时列为候选
- 候选按差距排序，同组谱面仍可能具有不同特征，实际提升需要复测确认
- 基础星级与修改器后的难度保持区分，动作判断需要回放或用户反馈支撑
- 每次统计返回页数、总量、样本量、去重数量、来源和读取状态
- `complete` 表示按 API 返回计数读取完成，分页期间的数据变化可能影响一致性
- `scoreImprovement` 保留为上游原始字段，解释前需确认语义与比较条件

## 验证

```powershell
pnpm test

# 已通过 pnpm configure 切换为本机 stdio 配置时
node scripts/smoke.js
node scripts/smoke.js 1922350521131465

# 本机或 Vercel HTTP MCP
node scripts/smoke.js --http http://127.0.0.1:3000/mcp
node scripts/smoke.js --http https://beatleader-mcp.vercel.app/mcp
```

提供玩家后，smoke 会调用公开 API 并验证五个工具；省略玩家时只检查握手、工具注册和输入错误

测试覆盖输入与时间边界、准确率单位、分组与去重、限流、错误响应、分页截断、Host 与 Origin 校验、Vercel 域名及 HTTP 请求边界

## 排查

| 现象 | 处理 |
|---|---|
| marketplace 添加失败 | 使用完整 Git 地址与 `--ref master`，确认仓库可访问并使用唯一 marketplace 名称 |
| 插件安装后连接失败 | 检查 `plugins/beatleader-mcp/.mcp.json` 是否指向可用的 `/mcp` 地址 |
| Vercel 根路径仍显示旧结果 | 检查生产部署对应的 Git 提交，再重新部署最新提交 |
| 自定义域名返回 403 | 将 `BEATLEADER_PUBLIC_URL` 设为该域名的 HTTPS Origin |
| `NETWORK_ERROR` | 检查 BeatLeader 连通性与 TLS 环境 |
| `REQUEST_ABORTED` | 单次调用总预算为 20 秒，缩小查询范围后重试 |
| `HTTP_429` | 按 `retryAfterMs` 稍后重试 |
| `HTTP_401` / `HTTP_403` | 核对上游权限与访问限制 |
| `HTTP_404` | 核对玩家、谱面 ID 与筛选条件 |
| `SCHEMA_CHANGED` | 检查 BeatLeader OpenAPI 的关键响应字段变化 |
| `coverage.complete` 为 false | 查看 `stopReason`、总量与样本量，按需要调整范围 |

429、502、503、504 最多重试一次，等待上限 5 秒；单次响应上限 4 MiB

## 接口来源

- [BeatLeader OpenAPI](https://api.beatleader.com/swagger/blapi/swagger.json)
- [BeatLeader PlayerScoresController](https://github.com/BeatLeader/beatleader-server/blob/master/Controllers/PlayerScoresController.cs)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

接口核对与公开 API 验证日期：2026-09-10
