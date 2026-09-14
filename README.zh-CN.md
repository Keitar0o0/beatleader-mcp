# BeatLeader Helper

[English](README.md) · [简体中文](README.zh-CN.md)

通过 BeatLeader 公开 API 查询玩家资料与成绩，在 Codex、ChatGPT 或其他 MCP 客户端中完成表现回顾、练习选图和练后对比

服务只读取公开数据，远程 MCP 部署在 Vercel

## 功能

| 工具 | 能力 |
|---|---|
| `get_player` | 查询基础资料、PP 与排名，通过 `include` 选取统计、Clan、社交和徽章 |
| `search_players` | 按昵称、国家和总 PP 区间找玩家，支持分项 PP 排序 |
| `search_maps` | 按星级、评级分量、模式、难度和 mapper ID 搜索谱面 |
| `list_player_scores` | 按时间、星级、准确率、修改器、难度、模式和歌曲筛选成绩，单页最多 100 条 |
| `get_player_history` | 查询 1～90 天每日统计快照，计算实际首末日期间的变化 |
| `get_leaderboard` | 查询谱面详情与排行榜，单页最多 50 条 |
| `analyze_player` | 读取最多 250 条成绩，计算分组统计并推荐最多 5 个已玩谱面 |

七个工具统一查询 `https://api.beatleader.com` 的公开 GET 接口

玩家资料按需查询，`include` 默认 `[]`，可组合 `stats`、`clans`、`socials`、`badges`

```json
{ "player": "76561198317719585", "include": ["stats", "clans", "socials", "badges"] }
```

`get_player` 返回 `sources`、`context`、`data` 和 `availability`；统计准确率使用百分比，时间使用 ISO 8601，各部分状态为 `available`、`unavailable` 或 `invalid`，空列表表示已获取且条目数为零

所有工具统一返回 `sources`、`context`、`data`，分页使用 `pagination: { page, count, total }`；成绩准确率使用 `accuracyPercent`，时间使用 `playedAt` / `postedAt`，分析候选位于 `data.estimates.practiceCandidates`

常用调用参数

```js
search_players({ search: "AQA", country: "CN", ppType: "acc" })
search_maps({ starsFrom: 6, starsTo: 8, mode: "Standard", type: "ranked" })
list_player_scores({ player: "76561198317719585", accFromPercent: 80, modifiers: "FS" })
analyze_player({ player: "76561198317719585", rankedOnly: true, maxPages: 2 })
```

玩家资料、历史和分析支持 `general`、`noMods`、`noPause`；搜索、成绩列表和单谱查询还支持 `golf`、`sCPM`、`speedrun`、`speedrunBackup`、`funny`、`backUp`、`leftLeader`

## 接入方式

| 场景 | 入口 |
|---|---|
| Codex | 从 GitHub 添加 marketplace，再安装「BeatLeader Helper」 |
| ChatGPT 或其他 MCP 客户端 | 连接 `https://beatleader-mcp.vercel.app/mcp` |
| 自托管 | 将仓库导入 Vercel |
| 本机开发 | 使用 HTTP 或 stdio 入口 |

## Codex 远程安装

添加 GitHub 仓库作为 marketplace

```powershell
codex plugin marketplace add https://github.com/Keitar0o0/beatleader-mcp.git --ref master
codex plugin add beatleader-mcp@beatleader
```

随后开启新任务加载「BeatLeader Helper」的工具与 Skill

相关地址各有独立职责

- 上述 Git 地址用于下载 marketplace
- `.agents/plugins/marketplace.json` 中的 `source: local` 指向 Git 工作区内的插件目录
- `plugins/beatleader-mcp/.mcp.json` 中的 URL 指向插件运行时连接的 Vercel MCP 服务

## 其他 MCP 客户端

使用以下远程配置

```json
{
  "mcpServers": {
    "beatleader": {
      "url": "https://beatleader-mcp.vercel.app/mcp"
    }
  }
}
```

远程 HTTP 的玩家工具要求显式提供玩家 ID、别名或主页链接；搜索工具直接接受搜索条件

## Vercel 部署

在 Vercel 中导入仓库并保持自动框架检测，部署完成后的 MCP 地址为 `https://你的域名/mcp`

Vercel 的当前部署域名与项目生产域名会自动加入 Host 白名单；使用额外自定义域名时，将 `BEATLEADER_PUBLIC_URL` 配置为 HTTPS Origin，例如 `https://mcp.example.com`

验证入口

```powershell
# 服务状态
Invoke-RestMethod https://你的域名/

# 健康检查
Invoke-RestMethod https://你的域名/health

# MCP 握手与工具发现
node scripts/smoke.js --http https://你的域名/mcp
```

## 本机开发

要求 Node.js 22 或更高版本、pnpm，以及可访问 BeatLeader 的网络

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm start:http
```

HTTP MCP 默认为 `http://127.0.0.1:3000/mcp`

stdio 入口使用 `pnpm start`；可通过 `BEATLEADER_PLAYER_ID` 配置默认玩家，显式 `player` 参数始终优先

如需从当前源码安装本机 marketplace

```powershell
pnpm configure
codex plugin marketplace add .
codex plugin add beatleader-mcp@beatleader
```

`pnpm configure` 会将插件 MCP 配置切换为当前 Node 与项目绝对路径，移动项目或更换 Node 后需重新执行

完成本机验证后，执行 `git restore -- plugins/beatleader-mcp/.mcp.json` 恢复仓库默认的 Vercel 配置

## 使用示例

beatleader-helper Skill 将现有查询组合成趋势解读、Top Plays、PP 构成、玩家比较、选图与复测流程；图表和文件使用客户端能力生成

- 「我的主页是 https://beatleader.com/u/你的ID，看看我的近期表现」
- 「看看我的 Top 8 Ranked 成绩，再展示最近 90 天的 PP 趋势」
- 「比较我和这位玩家共同谱面的表现，说明样本范围」
- 「最近一个月，Standard 模式里哪些旧图适合再练？」
- 「今天练准确率，给我三张旧图和观察目标」
- 「用这段对话的练前数据，比较这张图的新成绩」

## 数据边界

- 成绩列表代表所选排行榜上下文中的当前成绩样本
- 每日历史代表统计快照，日期缺口与平台重算需单独解释
- 完整练习过程、动作原因和提升效果需要尝试记录、回放、用户反馈或复测
- 部分分页结果会保留已读取样本，并通过 `coverage` 标明完整性与停止原因

## 项目结构

```text
.agents/plugins/marketplace.json       Codex marketplace 清单
plugins/beatleader-mcp/
  .codex-plugin/plugin.json            插件元数据
  .mcp.json                            默认 Vercel MCP 连接
  skills/beatleader-helper/SKILL.md     分析与练习流程
src/                                   工具、数据处理及 MCP 入口
index.js                               Vercel Express Function 入口
scripts/                               本机配置与 MCP 验证
test/                                  逻辑及 HTTP 集成测试
docs/development.md                    开发、验证与排查说明
```

开发细节见 [开发与排查](docs/development.md)
