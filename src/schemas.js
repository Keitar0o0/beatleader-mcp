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

const context = z.enum(['general', 'noMods', 'noPause', 'golf', 'sCPM', 'speedrun', 'speedrunBackup', 'funny', 'backUp', 'leftLeader']).default('general');
const analysisContext = z.enum(['general', 'noMods', 'noPause']).default('general');
const page = z.number().int().min(1).max(10000).default(1);
const count = z.number().int().min(1).max(100).default(20);
const search = z.string().trim().max(100).optional();
const difficulty = z.enum(['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus']).optional();
const mode = z.string().regex(/^[A-Za-z0-9_+-]{1,40}$/).optional();
const order = z.enum(['desc', 'asc']).default('desc');
const starRange = { starsFrom: z.number().min(0).max(100).optional(), starsTo: z.number().min(0).max(100).optional() };
const player = z.string().trim().min(1).max(300).optional()
  .describe('Player ID, alias, or https://beatleader.com/u/ID; stdio can use BEATLEADER_PLAYER_ID when omitted');
const instant = z.iso.datetime({ offset: true }).refine(v => {
  const seconds = Date.parse(v) / 1000;
  return seconds >= 0 && seconds <= 2147483647;
}, 'Timestamp must be within the API Unix int32 range');
const filters = {
  player, context,
  sort: z.enum(['date', 'pp', 'acc', 'stars', 'rank']).default('date'),
  order, search, difficulty, mode,
  rankedOnly: z.boolean().default(false),
  ...starRange,
  accFromPercent: z.number().min(0).max(100).optional(),
  accToPercent: z.number().min(0).max(100).optional(),
  modifiers: z.string().regex(/^(?:[A-Z]{2})(?:,[A-Z]{2})*$/).max(100).optional()
    .describe('BeatLeader modifier filter, e.g. FS or FS,SF'),
  from: instant.optional().describe('ISO start time with an explicit timezone'),
  to: instant.optional().describe('ISO end time with an explicit timezone'),
};
function ranges(value, ctx) {
  for (const [from, to] of [['starsFrom', 'starsTo'], ['accFromPercent', 'accToPercent'], ['ppFrom', 'ppTo'],
    ['accRatingFrom', 'accRatingTo'], ['passRatingFrom', 'passRatingTo'], ['techRatingFrom', 'techRatingTo']]) {
    if (value[from] > value[to]) ctx.addIssue({ code: 'custom', message: 'Minimum must be less than or equal to maximum', path: [from] });
  }
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    ctx.addIssue({ code: 'custom', message: 'Start time must be earlier than or equal to end time', path: ['from'] });
  }
}
export const schemas = {
  get_player: z.object({ player, context: analysisContext,
    include: z.array(z.enum(['stats', 'clans', 'socials', 'badges'])).max(4).default([])
      .describe('Optional profile sections; empty means basic profile only'),
  }).strict(),
  search_players: z.object({ context, page, count, search, order,
    country: z.string().regex(/^[A-Za-z]{2}$/).transform(v => v.toUpperCase()).optional(),
    sort: z.enum(['pp', 'rank', 'name', 'acc', 'topPp', 'playCount']).default('pp'),
    ppType: z.enum(['general', 'acc', 'pass', 'tech']).default('general'),
    ppFrom: z.number().min(0).max(1000000).optional(), ppTo: z.number().min(0).max(1000000).optional(),
  }).strict().superRefine(ranges),
  search_maps: z.object({ context, page, count, search, order, difficulty, mode, ...starRange,
    type: z.enum(['all', 'ranked', 'ranking', 'nominated', 'qualified', 'unranked', 'ost']).default('ranked'),
    sort: z.enum(['stars', 'accRating', 'passRating', 'techRating', 'playCount', 'name', 'timestamp']).default('stars'),
    mapperIds: z.array(z.number().int().positive()).min(1).max(20).optional().describe('BeatSaver mapper profile IDs'),
    ...Object.fromEntries(['accRatingFrom', 'accRatingTo', 'passRatingFrom', 'passRatingTo', 'techRatingFrom', 'techRatingTo']
      .map(key => [key, z.number().min(0).max(1000).optional()])),
  }).strict().superRefine(ranges),
  list_player_scores: z.object({ ...filters, page, count }).strict().superRefine(ranges),
  get_player_history: z.object({ player, context: analysisContext, days: z.number().int().min(1).max(90).default(30) }).strict(),
  get_leaderboard: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), context,
    page: z.number().int().min(1).max(10000).default(1),
    count: z.number().int().min(1).max(50).default(10),
  }).strict(),
  analyze_player: z.object({ ...filters, context: analysisContext,
    maxPages: z.number().int().min(1).max(5).default(2) }).strict().superRefine(ranges),
};

export function scoreQuery(a) {
  return {
    leaderboardContext: a.context, sortBy: a.sort, order: a.order,
    page: a.page, count: a.count, search: a.search, noSearchSort: true,
    diff: a.difficulty, mode: a.mode, type: a.rankedOnly ? 'ranked' : undefined,
    stars_from: a.starsFrom, stars_to: a.starsTo,
    acc_from: a.accFromPercent === undefined ? undefined : a.accFromPercent / 100,
    acc_to: a.accToPercent === undefined ? undefined : a.accToPercent / 100, modifiers: a.modifiers,
    time_from: a.from ? Math.floor(Date.parse(a.from) / 1000) : undefined,
    time_to: a.to ? Math.floor(Date.parse(a.to) / 1000) : undefined,
  };
}

export function playerQuery(a) {
  return { leaderboardContext: a.context, page: a.page, count: a.count, search: a.search,
    countries: a.country, sortBy: a.sort, order: a.order, ppType: a.ppType,
    pp_range: a.ppFrom === undefined && a.ppTo === undefined ? undefined : `${a.ppFrom ?? 0},${a.ppTo ?? 1000000}` };
}

export function mapQuery(a) {
  return { leaderboardContext: a.context, page: a.page, count: a.count, search: a.search,
    sortBy: a.sort, order: a.order, type: a.type, mode: a.mode, difficulty: a.difficulty,
    mappers: a.mapperIds?.join(','), stars_from: a.starsFrom, stars_to: a.starsTo,
    accrating_from: a.accRatingFrom, accrating_to: a.accRatingTo,
    passrating_from: a.passRatingFrom, passrating_to: a.passRatingTo,
    techrating_from: a.techRatingFrom, techrating_to: a.techRatingTo };
}
