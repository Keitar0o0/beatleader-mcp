import { schemas, playerId, scoreQuery, playerQuery, mapQuery } from './schemas.js';
import { request, responses, compactScore, compactPlayer, compactMap, compactHistory, ApiError } from './api.js';
import { summarize, historyChanges } from './analysis.js';

const scopeNote = 'Score sample for the selected leaderboard context; complete practice sessions and individual attempts require additional data';
export const descriptions = {
  get_player: 'Get a public player profile by ID, alias, or profile URL. Select stats, clans, socials, and badges with include; defaults to basic profile. Returns sources, context, data, and section availability. Accuracy uses percentages and times use ISO 8601',
  search_players: 'Search public players by nickname, country, total PP range and PP component sorting. Returns candidates with stable IDs; select an ID before querying a player',
  search_maps: 'Search leaderboard difficulties by song, ranked status, stars, Acc/Pass/Tech ratings, mode and BeatSaver mapper IDs. Results can be passed to get_leaderboard',
  list_player_scores: 'List current scores with pagination, percentage accuracy bounds, modifiers, dates, stars, difficulty, mode and song filters. Accuracy is 0–100; dates use ISO timestamps with timezones',
  get_player_history: 'Get 1–90 daily public player snapshots and calculate changes over actual returned dates, with percentage accuracy and ISO timestamps',
  get_leaderboard: 'Get map details and leaderboard scores to inspect difficulty, base ratings, and score conditions',
  analyze_player: 'Read up to five pages of fifty current scores, compute grouped percentage statistics, and suggest previously played maps for practice; includes coverage and sample limits. Supports general, noMods and noPause',
};

export async function execute(name, input, { signal, defaultPlayer = process.env.BEATLEADER_PLAYER_ID, requestFn = request } = {}) {
  if (!schemas[name]) throw new ApiError('UNKNOWN_TOOL', 'Unknown tool');
  const a = schemas[name].parse(input);
  const deadline = AbortSignal.timeout(20000);
  const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
  const contextQuery = { leaderboardContext: a.context };
  const envelope = r => ({ sources: [{ url: r.source, fetchedAt: r.fetchedAt }], context: a.context });
  const pagination = metadata => ({ page: metadata.page, count: metadata.itemsPerPage, total: metadata.total });
  if (name === 'search_players') {
    const r = await requestFn('/players', playerQuery(a), responses.players, options);
    return { ...envelope(r), data: r.data.data.map(player => compactPlayer(player, []).data), filters: a, pagination: pagination(r.data.metadata) };
  }
  if (name === 'search_maps') {
    const r = await requestFn('/leaderboards', mapQuery(a), responses.maps, options);
    return { ...envelope(r), data: r.data.data.map(compactMap), filters: a, pagination: pagination(r.data.metadata) };
  }
  if (name === 'get_leaderboard') {
    const r = await requestFn(`/leaderboard/${encodeURIComponent(a.id)}`, { ...contextQuery, page: a.page, count: a.count, sortBy: 'rank', order: 'asc' }, responses.leaderboard, options);
    return { ...envelope(r), data: { ...compactMap(r.data), scores: (r.data.scores ?? []).map(compactScore) },
      pagination: { page: a.page, count: a.count, total: null } };
  }
  const id = playerId(a.player ?? defaultPlayer);
  const path = `/player/${encodeURIComponent(id)}`;
  if (name === 'get_player') {
    const r = await requestFn(path, { ...contextQuery, stats: a.include.length > 0 }, responses.player, options);
    return { ...envelope(r), ...compactPlayer(r.data, a.include) };
  }
  if (name === 'get_player_history') {
    const r = await requestFn(`${path}/history`, { ...contextQuery, count: a.days }, responses.history, options);
    const history = [...new Map(r.data.toSorted((x, y) => x.timestamp - y.timestamp).map(row => [row.timestamp, compactHistory(row)])).values()];
    return { ...envelope(r), data: { player: id, requestedDays: a.days, returnedSnapshots: history.length, history, changes: historyChanges(history) },
      note: 'Daily snapshots; changes use actual first and last dates. Explain missing dates and platform recalculations separately' };
  }
  if (name === 'list_player_scores') {
    const r = await requestFn(`${path}/scores`, scoreQuery(a), responses.scores, options);
    return { ...envelope(r), filters: a, pagination: pagination(r.data.metadata), data: r.data.data.map(compactScore), note: scopeNote };
  }
  if (name !== 'analyze_player') throw new ApiError('UNKNOWN_TOOL', 'Unknown tool');
  const scores = [], sources = [];
  let firstTotal, lastTotal, exhausted = false, stopReason = 'page_limit', failure;
  for (let page = 1; page <= a.maxPages; page++) {
    let r;
    try { r = await requestFn(`${path}/scores`, scoreQuery({ ...a, page, count: 50 }), responses.scores, options); }
    catch (error) {
      if (page === 1 || signal?.aborted) throw error;
      failure = { code: error.code ?? 'UPSTREAM_ERROR', message: error.message };
      stopReason = options.signal.aborted ? 'deadline' : 'upstream_error';
      break;
    }
    const { metadata, data } = r.data;
    if (metadata.page !== page) throw new ApiError('PAGINATION_CHANGED', 'The upstream page number differs from the requested page');
    firstTotal ??= metadata.total;
    lastTotal = metadata.total;
    sources.push({ url: r.source, fetchedAt: r.fetchedAt });
    scores.push(...data.map(compactScore));
    if (page * metadata.itemsPerPage >= metadata.total) { exhausted = true; stopReason = 'end'; break; }
    if (data.length === 0) { stopReason = 'empty_page'; break; }
  }
  const summary = summarize(scores);
  const totalChanged = firstTotal !== lastTotal;
  const complete = exhausted && !totalChanged && summary.duplicateCount === 0 && summary.sampleCount === lastTotal;
  return {
    context: a.context, filters: a, sources,
    coverage: { pagesRead: sources.length, firstReportedTotal: firstTotal, lastReportedTotal: lastTotal,
      complete, totalChanged, stopReason, ...(failure ? { failure } : {}) },
    data: { player: id, ...summary }, note: scopeNote,
    collectionNote: 'Data may change during pagination; complete reflects the reported counts, while consistent snapshots require upstream support',
  };
}
