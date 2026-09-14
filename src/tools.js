import { schemas, playerId, scoreQuery } from './schemas.js';
import { request, responses, pick, compactScore, ApiError } from './api.js';
import { summarize } from './analysis.js';

const scopeNote = 'Score sample for the selected leaderboard context; complete practice sessions and individual attempts require additional data';
export const descriptions = {
  get_player: 'Get a public BeatLeader player profile, PP, ranks, and statistics using a player ID, profile URL, or configured stdio default',
  list_player_scores: 'List current scores with pagination and date, star rating, difficulty, mode, and song filters; dates require ISO timestamps with timezones',
  get_player_history: 'Get daily public player statistics for trend analysis over a 1 to 90 day window',
  get_leaderboard: 'Get map details and leaderboard scores to inspect difficulty, base ratings, and score conditions',
  summarize_player_scores: 'Read up to five pages of fifty scores, compute grouped statistics, and suggest previously played maps for practice; includes coverage and sample limits',
};

export async function execute(name, input, { signal, defaultPlayer = process.env.BEATLEADER_PLAYER_ID, requestFn = request } = {}) {
  const a = schemas[name].parse(input);
  const id = name === 'get_leaderboard' ? a.id : playerId(a.player ?? defaultPlayer);
  const path = `/player/${encodeURIComponent(id)}`;
  const options = { signal };
  const contextQuery = { leaderboardContext: a.context };
  const envelope = r => ({ source: r.source, fetchedAt: r.fetchedAt, context: a.context });
  if (name === 'get_player') {
    const r = await requestFn(path, { ...contextQuery, stats: true }, responses.player, options);
    return { ...envelope(r), player: pick(r.data, ['id', 'name', 'country', 'pp', 'rank', 'countryRank', 'accPp', 'passPp', 'techPp', 'scoreStats', 'contextExtensions']), url: `https://beatleader.com/u/${encodeURIComponent(r.data.id)}` };
  }
  if (name === 'get_player_history') {
    const r = await requestFn(`${path}/history`, { ...contextQuery, count: a.days }, responses.history, options);
    const history = r.data.toSorted((x, y) => x.timestamp - y.timestamp).map(row => pick(row, [
      'timestamp', 'context', 'playerId', 'pp', 'accPp', 'passPp', 'techPp', 'rank', 'countryRank',
      'averageRankedAccuracy', 'medianRankedAccuracy', 'totalPlayCount', 'totalImprovementsCount',
    ]));
    return { ...envelope(r), requestedDays: a.days, returnedSnapshots: history.length, history, note: 'Daily statistics snapshots; explain missing dates and platform recalculations separately; accuracy fields use ratios from 0 to 1' };
  }
  if (name === 'get_leaderboard') {
    const r = await requestFn(`/leaderboard/${encodeURIComponent(id)}`, { ...contextQuery, page: a.page, count: a.count, sortBy: 'rank', order: 'asc' }, responses.leaderboard, options);
    return { ...envelope(r), requestedPage: a.page, requestedCount: a.count,
      leaderboard: { ...pick(r.data, ['id', 'song', 'difficulty', 'plays']), scores: (r.data.scores ?? []).map(compactScore) },
      url: `https://beatleader.com/leaderboard/global/${encodeURIComponent(id)}` };
  }
  if (name === 'list_player_scores') {
    const r = await requestFn(`${path}/scores`, scoreQuery(a), responses.scores, options);
    return { ...envelope(r), filters: a, metadata: r.data.metadata,
      scores: r.data.data.map(compactScore), note: scopeNote, units: { accuracy: 'ratio_0_to_1', timeset: 'unix_seconds_string' } };
  }
  const scores = [], sources = [];
  let firstTotal, lastTotal, exhausted = false, stopReason = 'page_limit', failure;
  for (let page = 1; page <= a.maxPages; page++) {
    let r;
    try { r = await requestFn(`${path}/scores`, scoreQuery({ ...a, page, count: 50 }), responses.scores, options); }
    catch (error) {
      if (page === 1 || signal?.aborted) throw error;
      failure = { code: error.code ?? 'UPSTREAM_ERROR', message: error.message };
      stopReason = 'upstream_error';
      break;
    }
    const { metadata, data } = r.data;
    if (metadata.page !== page) throw new ApiError('PAGINATION_CHANGED', 'The upstream page number differs from the requested page');
    firstTotal ??= metadata.total;
    lastTotal = metadata.total;
    sources.push({ source: r.source, fetchedAt: r.fetchedAt });
    scores.push(...data.map(compactScore));
    if (page * metadata.itemsPerPage >= metadata.total) { exhausted = true; stopReason = 'end'; break; }
    if (data.length === 0) { stopReason = 'empty_page'; break; }
  }
  const summary = summarize(scores);
  const totalChanged = firstTotal !== lastTotal;
  const complete = exhausted && !totalChanged && summary.duplicateCount === 0 && summary.sampleCount === lastTotal;
  return {
    player: id, context: a.context, filters: a, sources,
    coverage: { pagesRead: sources.length, firstReportedTotal: firstTotal, lastReportedTotal: lastTotal,
      complete, totalChanged, stopReason, ...(failure ? { failure } : {}) },
    ...summary, note: scopeNote,
    collectionNote: 'Data may change during pagination; complete reflects the reported counts, while consistent snapshots require upstream support',
  };
}
