# BeatLeader Helper

[English](README.md) · [简体中文](README.zh-CN.md)

Query public BeatLeader profiles and scores from Codex, ChatGPT, or another MCP client to review performance, choose practice maps, and compare later results

The service only reads public data, and the remote MCP is deployed on Vercel

## Features

| Tool | Capability |
|---|---|
| `get_player` | Get a profile, PP, and ranks; select stats, clans, socials, and badges with `include` |
| `search_players` | Find nickname candidates by country and total PP range, with component PP sorting |
| `search_maps` | Search leaderboard difficulties by stars, ratings, mode, difficulty and mapper IDs |
| `list_player_scores` | Filter scores by time, stars, percentage accuracy, modifiers, difficulty, mode and song, with up to 100 results per page |
| `get_player_history` | Get 1–90 daily snapshots and changes between actual first and last dates |
| `get_leaderboard` | Get map details and leaderboard scores, with up to 50 results per page |
| `analyze_player` | Read up to 250 scores, calculate grouped statistics, and suggest up to 5 previously played maps |

All seven tools query public GET endpoints at `https://api.beatleader.com`

`get_player` accepts a player ID, alias, or profile URL. `include` defaults to `[]` for the basic profile

```json
{ "player": "76561198317719585", "include": ["stats", "clans", "socials", "badges"] }
```

Returns `sources`, `context`, `data`, and `availability`. Statistics use percentage accuracy and ISO 8601 times. Selected sections have status `available`, `unavailable`, or `invalid`; an empty list represents an available section with zero entries

All tools return `sources`, `context` and `data`; paginated results use `pagination: { page, count, total }`. Scores use `accuracyPercent`, `playedAt` and `postedAt`. Analysis candidates are in `data.estimates.practiceCandidates`

```js
search_players({ search: "AQA", country: "CN", ppType: "acc" })
search_maps({ starsFrom: 6, starsTo: 8, mode: "Standard", type: "ranked" })
list_player_scores({ player: "76561198317719585", accFromPercent: 80, modifiers: "FS" })
analyze_player({ player: "76561198317719585", rankedOnly: true, maxPages: 2 })
```

Profile, history and analysis support `general`, `noMods`, `noPause`. Search, score listing and leaderboard queries also support `golf`, `sCPM`, `speedrun`, `speedrunBackup`, `funny`, `backUp`, `leftLeader`

## Connection options

| Use case | Entry point |
|---|---|
| Codex | Add the GitHub marketplace, then install 「BeatLeader Helper」 |
| ChatGPT or another MCP client | Connect to `https://beatleader-mcp.vercel.app/mcp` |
| Self-hosting | Import the repository into Vercel |
| Local development | Use the HTTP or stdio entry point |

## Remote Codex installation

Add the GitHub repository as a marketplace

```powershell
codex plugin marketplace add https://github.com/Keitar0o0/beatleader-mcp.git --ref master
codex plugin add beatleader-mcp@beatleader
```

Start a new task after installation to load the 「BeatLeader Helper」 tools and skill

Each address has a separate role

- The Git URL downloads the marketplace
- `source: local` in `.agents/plugins/marketplace.json` points to the plugin inside the Git checkout
- The URL in `plugins/beatleader-mcp/.mcp.json` connects the installed plugin to the Vercel MCP service

## Other MCP clients

Use this remote configuration

```json
{
  "mcpServers": {
    "beatleader": {
      "url": "https://beatleader-mcp.vercel.app/mcp"
    }
  }
}
```

Player tools over HTTP require an explicit player ID, alias, or profile URL; search tools accept their query filters directly

## Vercel deployment

Import the repository into Vercel with automatic framework detection; the deployed MCP endpoint is `https://your-domain/mcp`

Vercel's current deployment and project production domains are added to the Host allowlist automatically; for an additional custom domain, set `BEATLEADER_PUBLIC_URL` to its HTTPS origin, such as `https://mcp.example.com`

Verify the deployment through these endpoints

```powershell
# Service status
Invoke-RestMethod https://your-domain/

# Health check
Invoke-RestMethod https://your-domain/health

# MCP handshake and tool discovery
node scripts/smoke.js --http https://your-domain/mcp
```

## Local development

Requires Node.js 22 or later, pnpm, and network access to BeatLeader

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm start:http
```

The local HTTP endpoint defaults to `http://127.0.0.1:3000/mcp`

Run the stdio entry point with `pnpm start`; `BEATLEADER_PLAYER_ID` can provide a default player, while an explicit `player` argument always takes priority

To install the current source as a local marketplace

```powershell
pnpm configure
codex plugin marketplace add .
codex plugin add beatleader-mcp@beatleader
```

`pnpm configure` switches the plugin MCP configuration to absolute paths for the current Node executable and project, so rerun it after moving the project or changing Node

After local verification, run `git restore -- plugins/beatleader-mcp/.mcp.json` to restore the repository's default Vercel configuration

## Usage examples

The beatleader-helper Skill combines existing queries for trends, Top Plays, PP composition, player comparisons, map selection and follow-up reviews. Charts and files use the client's available tools

- 「My profile is https://beatleader.com/u/YOUR_ID — review my recent performance」
- 「Which previously played Standard maps from the past month should I practice again?」
- 「I want to practice accuracy today — give me three previously played maps and targets to watch」
- 「Compare my new score on this map with the pre-practice data in this conversation」

## Data boundaries

- Score lists are current samples from the selected leaderboard context
- Daily history contains statistics snapshots whose missing dates and platform recalculations need separate interpretation
- Complete practice sessions, movement causes, and improvement claims require attempt logs, replays, user feedback, or retesting
- Partial pagination keeps the retrieved sample and reports completeness and stop reasons through `coverage`

## Project structure

```text
.agents/plugins/marketplace.json       Codex marketplace manifest
plugins/beatleader-mcp/
  .codex-plugin/plugin.json            Plugin metadata
  .mcp.json                            Default Vercel MCP connection
  skills/beatleader-helper/SKILL.md     Analysis and practice workflow
src/                                   Tools, data processing, and MCP entry points
index.js                               Vercel Express Function entry point
scripts/                               Local configuration and MCP verification
test/                                  Logic and HTTP integration tests
docs/development.md                    Development, verification, and troubleshooting
```

See [Development and troubleshooting](docs/development.md) for implementation details
