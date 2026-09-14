import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { playerId, schemas, scoreQuery, playerQuery, mapQuery } from '../src/schemas.js';
import { summarize, median, historyChanges } from '../src/analysis.js';
import { request, retryDelay, compactScore, ApiError } from '../src/api.js';
import { execute } from '../src/tools.js';

const summarizeScores = scores => summarize(scores.map(compactScore));

test('搜索映射、百分比筛选与独立搜索入口', async () => {
  const playerArgs = schemas.search_players.parse({ country: 'cn', ppFrom: 100, ppTo: 200, ppType: 'tech' });
  assert.equal(playerQuery(playerArgs).pp_range, '100,200');
  assert.equal(playerQuery(playerArgs).countries, 'CN');
  assert.equal(playerQuery(playerArgs).ppType, 'tech');
  const mapArgs = schemas.search_maps.parse({ mapperIds: [1, 2], accRatingFrom: 5, techRatingTo: 8 });
  assert.equal(mapQuery(mapArgs).mappers, '1,2');
  assert.equal(mapQuery(mapArgs).accrating_from, 5);
  assert.equal(mapQuery(mapArgs).techrating_to, 8);
  assert.equal(scoreQuery(schemas.list_player_scores.parse({ accFromPercent: 80 })).acc_from, 0.8);
  assert.equal(scoreQuery(schemas.list_player_scores.parse({ accToPercent: 0, modifiers: 'FS' })).acc_to, 0);
  for (const [name, args] of [['search_players', { ppFrom: 200, ppTo: 100 }], ['search_maps', { accRatingFrom: 8, accRatingTo: 5 }],
    ['list_player_scores', { accFromPercent: 90, accToPercent: 80 }], ['analyze_player', { context: 'golf' }]]) {
    assert.equal(schemas[name].safeParse(args).success, false);
  }
  for (const name of ['search_players', 'search_maps']) {
    const r = await execute(name, {}, { defaultPlayer: '', requestFn: async (path, query) => {
      assert.equal(path, name === 'search_players' ? '/players' : '/leaderboards');
      return { source: path, fetchedAt: 'now', data: { metadata: { page: 1, itemsPerPage: 20, total: 2 }, data: name === 'search_players'
        ? [{ id: '1', name: 'Same' }, { id: '2', name: 'Same' }]
        : [{ id: 'map1', song: { name: 'Song' }, difficulty: { stars: 5 } }] } };
    } });
    assert.equal(r.pagination.total, 2);
    assert.ok(r.data[0].url);
    assert.equal(r.sources.length, 1);
    if (name === 'search_players') assert.deepEqual(r.data.map(p => p.id), ['1', '2']);
  }
  await assert.rejects(execute('summarize_player_scores', {}), e => e.code === 'UNKNOWN_TOOL');
});

test('历史实际区间、缺口、去重及零基数变化', async () => {
  const r = await execute('get_player_history', { player: '123' }, { requestFn: async () => ({ data: [
    { timestamp: 172800, pp: 120, rank: 80, averageRankedAccuracy: 0.9 },
    { timestamp: 86400, pp: 100, rank: 100, averageRankedAccuracy: 0.8 },
    { timestamp: 172800, pp: 120, rank: 80, averageRankedAccuracy: 0.9 },
  ] }) });
  assert.equal(r.data.returnedSnapshots, 2);
  assert.equal(r.data.changes.pp, 20);
  assert.equal(r.data.changes.ppPercent, 20);
  assert.equal(r.data.changes.rankImprovement, 20);
  assert.equal(r.data.changes.averageRankedAccuracyPercentagePoints, 10);
  assert.equal(r.data.changes.from, '1970-01-02T00:00:00.000Z');
  assert.equal(historyChanges([]).status, 'insufficient_snapshots');
  assert.equal(historyChanges([{ timestamp: 'a' }]).status, 'insufficient_snapshots');
  const zero = historyChanges([{ timestamp: 'a', pp: 0 }, { timestamp: 'b', pp: 10 }]);
  assert.equal(zero.ppPercent, null);
  assert.equal(zero.ppPercentStatus, 'zero_baseline');
});

test('成绩和谱面统一输出契约', async () => {
  const raw = score(1, 0.8, { timeset: '1700000000', timepost: 1700000010, scoreImprovement: { accuracy: 0.1 } });
  const requestFn = async path => ({ source: path, fetchedAt: 'now', data: path.startsWith('/leaderboard/')
    ? { ...raw.leaderboard, scores: [raw], plays: 999 }
    : { metadata: { page: 1, itemsPerPage: 20, total: 1 }, data: [raw] } });
  const listed = await execute('list_player_scores', { player: '123' }, { requestFn });
  const board = await execute('get_leaderboard', { id: 'map1' }, { requestFn });
  for (const row of [listed.data[0], board.data.scores[0]]) {
    assert.equal(row.accuracyPercent, 80);
    assert.equal(row.playedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(row.accuracy, undefined);
    assert.equal(row.timeset, undefined);
    assert.equal(row.scoreImprovement, undefined);
  }
  assert.equal(board.pagination.total, null);
});

test('输入边界与时区换算', () => {
  assert.equal(playerId('https://beatleader.com/u/123?x=y'), '123');
  assert.equal(playerId('alias_name'), 'alias_name');
  for (const v of ['', '../123', 'https://evil.com/u/123', 'https://beatleader.com/else/123']) assert.throws(() => playerId(v));
  const a = schemas.list_player_scores.parse({ from: '2026-09-01T08:00:00+08:00' });
  assert.equal(scoreQuery(a).time_from, Date.parse('2026-09-01T00:00:00Z') / 1000);
  for (const v of [{ count: 101 }, { page: 0 }, { from: '2026-09-01' }, { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' }, { starsFrom: 6, starsTo: 4 }, { arbitraryUrl: 'https://evil.com' }]) {
    assert.equal(schemas.list_player_scores.safeParse(v).success, false);
  }
});

function score(id, accuracy, overrides = {}) {
  return { id, accuracy, modifiers: '', leaderboardId: `map${id}`, leaderboard: {
    id: `map${id}`, song: { name: `Map ${id}` }, difficulty: { modeName: 'Standard', difficultyName: 'Expert', status: 3, stars: 5 },
  }, ...overrides };
}
test('统计处理重复、空值、分组和百分点', () => {
  assert.equal(median([]), null);
  assert.equal(median([1, 3, 2, 4]), 2.5);
  const scores = [score(1, 0.90), score(2, 0.95), score(3, 0.96), score(4, 0.97), score(5, 0.98)];
  const r = summarizeScores([...scores, scores[0], score(6, null), score(7, 0.5, { modifiers: 'FS' })]);
  assert.equal(r.duplicateCount, 1);
  assert.equal(r.groups.length, 2);
  assert.equal(r.estimates.practiceCandidates[0].gapPercentagePoints, 6.5);
  assert.equal(r.estimates.practiceCandidates[0].peerCount, 4);
  assert.equal(r.estimates.practiceCandidates.some(s => s.scoreId === 7), false);
  assert.equal(summarizeScores(scores.slice(0, 4)).estimates.practiceCandidates.length, 0);
  assert.equal(summarizeScores([score(1, null)]).medianAccuracyPercent, null);
  assert.equal(summarizeScores([score(1, 1.2)]).accuracySampleCount, 0);
  assert.equal(summarizeScores([score(1, 0.2, { modifiers: undefined })]).groups.length, 0);
});

test('请求限流重试、错误状态与响应校验', async () => {
  let calls = 0;
  const r = await request('/player/123', { count: 1, skip: undefined }, z.object({ id: z.string() }), {
    fetchFn: async url => {
      assert.equal(url.origin, 'https://api.beatleader.com');
      assert.equal(url.searchParams.has('skip'), false);
      return ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json({ id: '123' });
    }, sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(r.data.id, '123');
  assert.equal(retryDelay('2'), 2000);
  await assert.rejects(request('//evil.com', {}, z.any()), e => e.code === 'INVALID_ORIGIN');
  for (const [response, code] of [
    [new Response('', { status: 404 }), 'HTTP_404'],
    [new Response('', { status: 429, headers: { 'Retry-After': '60' } }), 'HTTP_429'],
    [new Response('oops'), 'INVALID_JSON'],
    [Response.json({ id: null }), 'SCHEMA_CHANGED'],
    [new Response(' '.repeat(4 * 1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
  ]) await assert.rejects(request('/player/123', {}, z.object({ id: z.string() }), { fetchFn: async () => response }), e => e.code === code);
  const signal = AbortSignal.abort();
  await assert.rejects(request('/player/123', {}, z.any(), { signal, fetchFn: async () => { signal.throwIfAborted(); } }), e => e.code === 'REQUEST_ABORTED');
});

function pages(total, data, failPage) {
  return async (_path, query) => {
    if (query.page === failPage) throw new ApiError('HTTP_503', '服务暂忙');
    return { source: `https://api.beatleader.com/test?page=${query.page}`, fetchedAt: '2026-09-10T00:00:00Z',
      data: { metadata: { page: query.page, itemsPerPage: 50, total }, data: data[query.page - 1] ?? [] } };
  };
}
test('分页截断与部分失败始终携带覆盖信息', async () => {
  const first = Array.from({ length: 50 }, (_, i) => score(i + 1, 0.95));
  const second = Array.from({ length: 10 }, (_, i) => score(i + 51, 0.95));
  const args = { player: '123' };
  const full = await execute('analyze_player', args, { requestFn: pages(60, [first, second]) });
  assert.equal(full.coverage.complete, true);
  assert.equal(full.data.sampleCount, 60);
  const capped = await execute('analyze_player', { ...args, maxPages: 1 }, { requestFn: pages(60, [first, second]) });
  assert.equal(capped.coverage.complete, false);
  assert.equal(capped.coverage.stopReason, 'page_limit');
  const partial = await execute('analyze_player', args, { requestFn: pages(60, [first], 2) });
  assert.equal(partial.coverage.stopReason, 'upstream_error');
  assert.equal(partial.data.sampleCount, 50);
  const dup = await execute('analyze_player', args, { requestFn: pages(60, [first, first.slice(0, 10)]) });
  assert.equal(dup.coverage.complete, false);
  assert.equal(dup.data.duplicateCount, 10);
  const empty = await execute('analyze_player', args, { requestFn: pages(0, [[]]) });
  assert.equal(empty.coverage.complete, true);
  const changing = await execute('analyze_player', args, { requestFn: async (path, query) => pages(query.page === 1 ? 60 : 59, [first, second.slice(0, 9)])(path, query) });
  assert.equal(changing.coverage.totalChanged, true);
  assert.equal(changing.coverage.complete, false);
  const controller = new AbortController();
  let sharedSignal;
  await assert.rejects(execute('analyze_player', args, { signal: controller.signal, requestFn: async (path, query, schema, options) => {
    sharedSignal ??= options.signal;
    assert.equal(options.signal, sharedSignal);
    if (query.page === 2) {
      controller.abort();
      options.signal.throwIfAborted();
    }
    return pages(60, [first, second])(path, query);
  } }), e => e.name === 'AbortError');
});

test('默认玩家与历史排序、精简输出', async () => {
  let requested;
  const profile = await execute('get_player', {}, { defaultPlayer: '123', requestFn: async path => {
    requested = path; return { data: { id: '123', name: 'Test', richBio: 'untrusted' }, source: 'test', fetchedAt: 'now' };
  } });
  assert.equal(requested, '/player/123');
  assert.equal(profile.data.richBio, undefined);
  const history = await execute('get_player_history', { player: '123' }, { requestFn: async () => ({ data: [{ timestamp: 2 }, { timestamp: 1 }], source: 'test' }) });
  assert.equal(history.data.history[0].timestamp, '1970-01-01T00:00:01.000Z');
  assert.equal(compactScore(score(1, 0.95)).url, 'https://beatleader.com/leaderboard/global/map1');
});

test('玩家资料按需选择、单位转换与部分数据状态', async () => {
  const sections = ['stats', 'clans', 'socials', 'badges'];
  const upstream = { id: '123', name: 'Test', richBio: 'discard', scoreStats: {
    totalPlayCount: 0, averageRankedAccuracy: 0.8793, medianAccuracy: null,
    firstScoreTime: 0, lastScoreTime: 1700000000, arbitrary: 'discard',
  }, clans: [{ id: 1, tag: 'ABC', color: '#fff', bio: 'discard' }],
  socials: [{ service: 'Twitch', user: 'test', link: 'https://twitch.tv/test', hidden: false }, { service: 'private', hidden: true }],
  badges: [{ id: 2, description: 'Award', timeset: 1700000000, player: { richBio: 'discard' } }] };
  for (let mask = 0; mask < 16; mask++) {
    const include = sections.filter((_, i) => mask & (1 << i));
    let calls = 0;
    const result = await execute('get_player', { player: '123', context: 'noMods', include }, { requestFn: async (path, query) => {
      calls++;
      assert.equal(path, '/player/123');
      assert.deepEqual(query, { leaderboardContext: 'noMods', stats: include.length > 0 });
      return { data: upstream, source: 'https://api.beatleader.com/player/123', fetchedAt: 'now' };
    } });
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(result.availability), include);
    for (const section of sections) assert.equal(Object.hasOwn(result.data, section), include.includes(section));
    assert.equal(result.data.richBio, undefined);
    assert.equal(result.sources[0].fetchedAt, 'now');
    if (include.includes('stats')) assert.deepEqual(result.data.stats, {
      totalPlayCount: 0, averageRankedAccuracyPercent: 87.93, medianAccuracyPercent: null,
      firstScoreTime: null, lastScoreTime: '2023-11-14T22:13:20.000Z',
    });
    if (include.includes('socials')) assert.equal(result.data.socials.length, 1);
    if (include.includes('badges')) assert.deepEqual(result.data.badges, [{ id: 2, description: 'Award', awardedAt: '2023-11-14T22:13:20.000Z' }]);
  }
  const partial = await execute('get_player', { player: '123', include: sections }, { requestFn: async () => ({
    data: { id: '123', name: 'Test', scoreStats: { averageAccuracy: 87 }, clans: [], socials: null },
  }) });
  assert.deepEqual(partial.availability, { stats: 'invalid', clans: 'available', socials: 'unavailable', badges: 'unavailable' });
  assert.deepEqual(partial.data.clans, []);
  assert.equal(partial.data.stats, null);
  assert.equal(partial.data.socials, null);
  assert.deepEqual(schemas.get_player.parse({}).include, []);
  assert.equal(schemas.get_player.safeParse({ include: ['history'] }).success, false);
});
