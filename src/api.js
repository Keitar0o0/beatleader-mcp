import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export const API = 'https://api.beatleader.com';
const metadata = z.object({ page: z.number().int().positive(), itemsPerPage: z.number().int().positive(), total: z.number().int().nonnegative() });
const score = z.object({ id: z.number().int(), playerId: z.string().optional() }).passthrough();
export const responses = {
  scores: z.object({ metadata, data: z.array(score) }),
  players: z.object({ metadata, data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) }),
  maps: z.object({ metadata, data: z.array(z.object({ id: z.string(), song: z.object({}).passthrough(), difficulty: z.object({}).passthrough() }).passthrough()) }),
  player: z.object({ id: z.string(), name: z.string() }).passthrough(),
  history: z.array(z.object({ timestamp: z.number().int().positive().max(2147483647) }).passthrough()),
  leaderboard: z.object({ id: z.string(), scores: z.array(score).nullable().optional() }).passthrough(),
};

export class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function retryDelay(value) {
  if (!value) return 1000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 1000;
}

export async function request(path, query, schema, { signal, fetchFn = fetch, sleep = delay } = {}) {
  const url = new URL(path, API);
  if (url.origin !== API) throw new ApiError('INVALID_ORIGIN', 'Only the BeatLeader API is supported');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const deadline = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchFn(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'beatleader-mcp/0.1.0' },
        redirect: 'error', signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const waitMs = retryDelay(response.headers.get('Retry-After'));
        if (attempt === 0 && [429, 502, 503, 504].includes(response.status) && waitMs <= 5000) {
          await sleep(waitMs, undefined, { signal: combined });
          continue;
        }
        const messages = { 404: 'Check the resource ID and current filters', 401: 'This endpoint requires authorization', 403: 'The upstream service restricted this request', 429: 'BeatLeader rate limit reached; retry later' };
        throw new ApiError(`HTTP_${response.status}`, messages[response.status] ?? 'BeatLeader request failed', {
          status: response.status, source: url.href,
          ...(response.status === 429 ? { retryAfterMs: waitMs } : {}),
        });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new ApiError('RESPONSE_TOO_LARGE', 'Response exceeds 4 MiB; narrow the query');
        chunks.push(chunk);
      }
      let json;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ApiError('INVALID_JSON', 'Invalid upstream JSON response'); }
      const result = schema.safeParse(json);
      if (!result.success) throw new ApiError('SCHEMA_CHANGED', 'Required upstream fields changed; check the API contract');
      return { data: result.data, source: url.href, fetchedAt: new Date().toISOString() };
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(combined.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR', combined.aborted ? 'Request timed out or was cancelled' : 'Connection to BeatLeader failed; check network and TLS settings');
  }
}

export function pick(object, keys) {
  return Object.fromEntries(keys.filter(k => object?.[k] !== undefined).map(k => [k, object[k]]));
}

const statNumbers = ['totalPlayCount', 'rankedPlayCount', 'unrankedPlayCount', 'totalImprovementsCount', 'topPp', 'topAccPP', 'topPassPP', 'topTechPP'];
const statAccuracies = ['averageAccuracy', 'averageRankedAccuracy', 'averageUnrankedAccuracy', 'medianAccuracy', 'medianRankedAccuracy', 'topAccuracy'];
const statTimes = ['firstScoreTime', 'lastScoreTime'];
const optionalStrings = keys => Object.fromEntries(keys.map(key => [key, z.string().nullish()]));
const profileSections = {
  stats: z.object(Object.fromEntries([
    ...statNumbers.map(key => [key, z.number().finite().nullish()]),
    ...statAccuracies.map(key => [key, z.number().min(0).max(1).nullish()]),
    ...statTimes.map(key => [key, z.number().int().min(0).max(2147483647).nullish()]),
  ])),
  clans: z.array(z.object({ id: z.number().int(), ...optionalStrings(['tag', 'color']) })),
  socials: z.array(z.object({ ...optionalStrings(['service', 'link', 'user']), hidden: z.boolean().optional() })),
  badges: z.array(z.object({ id: z.number().int(), ...optionalStrings(['description', 'details', 'image', 'link']),
    timeset: z.number().int().min(0).max(2147483647).nullish(), hidden: z.boolean().optional() })),
};
export function isoTime(value) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 && seconds <= 2147483647
    ? new Date(seconds * 1000).toISOString() : null;
}
export const accuracyPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  ? Math.round(value * 1000000) / 10000 : null;

export function compactPlayer(player, include) {
  const data = pick(player, ['id', 'name', 'alias', 'avatar', 'platform', 'country', 'pp', 'rank', 'countryRank', 'accPp', 'passPp', 'techPp']);
  data.url = `https://beatleader.com/u/${encodeURIComponent(player.id)}`;
  const availability = {};
  for (const section of new Set(include)) {
    const raw = player[section === 'stats' ? 'scoreStats' : section];
    const parsed = profileSections[section].safeParse(raw);
    availability[section] = raw == null ? 'unavailable' : parsed.success ? 'available' : 'invalid';
    data[section] = null;
    if (!parsed.success) continue;
    if (section === 'stats') {
      data.stats = {
        ...pick(parsed.data, statNumbers),
        ...Object.fromEntries(statAccuracies.filter(key => parsed.data[key] !== undefined)
          .map(key => [`${key}Percent`, accuracyPercent(parsed.data[key])])),
        ...Object.fromEntries(statTimes.filter(key => parsed.data[key] !== undefined).map(key => [key, isoTime(parsed.data[key])])),
      };
    } else {
      data[section] = parsed.data.filter(row => !row.hidden).map(({ hidden, timeset, ...row }) =>
        section === 'badges' ? { ...row, awardedAt: isoTime(timeset) } : row);
    }
  }
  return { data, availability };
}

export function compactScore(s) {
  const leaderboard = s.leaderboard;
  return {
    ...pick(s, ['id', 'playerId', 'pp', 'rank', 'badCuts', 'missedNotes', 'bombCuts', 'wallsHit', 'pauses', 'fullCombo', 'modifiers']),
    leaderboardId: s.leaderboardId ?? leaderboard?.id,
    accuracyPercent: accuracyPercent(s.accuracy), playedAt: isoTime(s.timeset), postedAt: isoTime(s.timepost),
    ...(leaderboard ? { leaderboard: compactMap(leaderboard) } : {}),
    ...(s.leaderboardId ?? leaderboard?.id ? { url: `https://beatleader.com/leaderboard/global/${encodeURIComponent(s.leaderboardId ?? leaderboard.id)}` } : {}),
  };
}

export function compactMap(board) {
  return { id: board.id,
    song: pick(board.song, ['id', 'name', 'author', 'mapper', 'duration', 'bpm']),
    difficulty: pick(board.difficulty, ['difficultyName', 'modeName', 'status', 'stars', 'accRating', 'passRating', 'techRating', 'duration', 'nps', 'notes', 'bombs', 'walls', 'type']),
    url: `https://beatleader.com/leaderboard/global/${encodeURIComponent(board.id)}` };
}

export function compactHistory(row) {
  return { ...pick(row, ['playerId', 'pp', 'accPp', 'passPp', 'techPp', 'rank', 'countryRank', 'totalPlayCount', 'totalImprovementsCount']),
    timestamp: isoTime(row.timestamp), averageRankedAccuracyPercent: accuracyPercent(row.averageRankedAccuracy),
    medianRankedAccuracyPercent: accuracyPercent(row.medianRankedAccuracy) };
}
