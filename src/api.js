import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export const API = 'https://api.beatleader.com';
const metadata = z.object({ page: z.number().int().positive(), itemsPerPage: z.number().int().positive(), total: z.number().int().nonnegative() });
const score = z.object({ id: z.number().int(), playerId: z.string().optional() }).passthrough();
export const responses = {
  scores: z.object({ metadata, data: z.array(score) }),
  player: z.object({ id: z.string(), name: z.string() }).passthrough(),
  history: z.array(z.object({ timestamp: z.number().int() }).passthrough()),
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

export function compactScore(s) {
  const leaderboard = s.leaderboard;
  return {
    ...pick(s, ['id', 'playerId', 'accuracy', 'pp', 'rank', 'badCuts', 'missedNotes', 'bombCuts', 'wallsHit', 'pauses', 'fullCombo', 'modifiers', 'timeset', 'timepost', 'leaderboardId', 'scoreImprovement']),
    ...(leaderboard ? { leaderboard: {
      id: leaderboard.id,
      song: pick(leaderboard.song, ['id', 'name', 'author', 'mapper', 'duration']),
      difficulty: pick(leaderboard.difficulty, ['difficultyName', 'modeName', 'status', 'stars', 'accRating', 'passRating', 'techRating', 'duration', 'nps', 'type']),
    } } : {}),
    ...(s.leaderboardId ?? leaderboard?.id ? { url: `https://beatleader.com/leaderboard/global/${encodeURIComponent(s.leaderboardId ?? leaderboard.id)}` } : {}),
  };
}
