import { z } from 'zod';

export function playerId(value) {
  let id = value?.trim();
  if (!id) throw new Error('Provide a player ID or profile URL; stdio also supports BEATLEADER_PLAYER_ID');
  if (id.startsWith('https://')) {
    const url = new URL(id);
    if (!['beatleader.com', 'www.beatleader.com', 'beatleader.xyz', 'www.beatleader.xyz'].includes(url.hostname)) {
      throw new Error('Use a BeatLeader player profile URL');
    }
    id = /^\/u\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid player ID or profile URL');
  return id;
}

const context = z.enum(['general', 'noMods', 'noPause']).default('general');
const player = z.string().trim().min(1).max(300).optional()
  .describe('Player ID, alias, or https://beatleader.com/u/ID; stdio can use BEATLEADER_PLAYER_ID when omitted');
const instant = z.iso.datetime({ offset: true }).refine(v => {
  const seconds = Date.parse(v) / 1000;
  return seconds >= 0 && seconds <= 2147483647;
}, 'Timestamp must be within the API Unix int32 range');
const filters = {
  player, context,
  sort: z.enum(['date', 'pp', 'acc', 'stars', 'rank']).default('date'),
  order: z.enum(['desc', 'asc']).default('desc'),
  search: z.string().trim().max(100).optional(),
  difficulty: z.enum(['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus']).optional(),
  mode: z.string().regex(/^[A-Za-z0-9_+-]{1,40}$/).optional(),
  rankedOnly: z.boolean().default(false),
  starsFrom: z.number().min(0).max(100).optional(),
  starsTo: z.number().min(0).max(100).optional(),
  from: instant.optional().describe('ISO start time with an explicit timezone'),
  to: instant.optional().describe('ISO end time with an explicit timezone'),
};
function ranges(value, ctx) {
  if (value.starsFrom > value.starsTo) ctx.addIssue({ code: 'custom', message: 'Minimum stars must be less than or equal to maximum stars', path: ['starsFrom'] });
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    ctx.addIssue({ code: 'custom', message: 'Start time must be earlier than or equal to end time', path: ['from'] });
  }
}
export const schemas = {
  get_player: z.object({ player, context }).strict(),
  list_player_scores: z.object({ ...filters, page: z.number().int().min(1).max(10000).default(1), count: z.number().int().min(1).max(100).default(20) }).strict().superRefine(ranges),
  get_player_history: z.object({ player, context, days: z.number().int().min(1).max(90).default(30) }).strict(),
  get_leaderboard: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), context,
    page: z.number().int().min(1).max(10000).default(1),
    count: z.number().int().min(1).max(50).default(10),
  }).strict(),
  summarize_player_scores: z.object({ ...filters, maxPages: z.number().int().min(1).max(5).default(2) }).strict().superRefine(ranges),
};

export function scoreQuery(a) {
  return {
    leaderboardContext: a.context, sortBy: a.sort, order: a.order,
    page: a.page, count: a.count, search: a.search, noSearchSort: true,
    diff: a.difficulty, mode: a.mode, type: a.rankedOnly ? 'ranked' : undefined,
    stars_from: a.starsFrom, stars_to: a.starsTo,
    time_from: a.from ? Math.floor(Date.parse(a.from) / 1000) : undefined,
    time_to: a.to ? Math.floor(Date.parse(a.to) / 1000) : undefined,
    includeIO: true,
  };
}
