import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { playerId, schemas, scoreQuery } from '../src/schemas.js';
import { summarize, median } from '../src/analysis.js';
import { request, retryDelay, compactScore, ApiError } from '../src/api.js';
import { execute } from '../src/tools.js';

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
  const r = summarize([...scores, scores[0], score(6, null), score(7, 0.5, { modifiers: 'FS' })]);
  assert.equal(r.duplicateCount, 1);
  assert.equal(r.groups.length, 2);
  assert.equal(r.practiceCandidates[0].gapPercentagePoints, 6.5);
  assert.equal(r.practiceCandidates[0].peerCount, 4);
  assert.equal(r.practiceCandidates.some(s => s.scoreId === 7), false);
  assert.equal(summarize(scores.slice(0, 4)).practiceCandidates.length, 0);
  assert.equal(summarize([score(1, null)]).medianAccuracyPercent, null);
  assert.equal(summarize([score(1, 1.2)]).accuracySampleCount, 0);
  assert.equal(summarize([score(1, 0.2, { modifiers: undefined })]).groups.length, 0);
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
  const full = await execute('summarize_player_scores', args, { requestFn: pages(60, [first, second]) });
  assert.equal(full.coverage.complete, true);
  assert.equal(full.sampleCount, 60);
  const capped = await execute('summarize_player_scores', { ...args, maxPages: 1 }, { requestFn: pages(60, [first, second]) });
  assert.equal(capped.coverage.complete, false);
  assert.equal(capped.coverage.stopReason, 'page_limit');
  const partial = await execute('summarize_player_scores', args, { requestFn: pages(60, [first], 2) });
  assert.equal(partial.coverage.stopReason, 'upstream_error');
  assert.equal(partial.sampleCount, 50);
  const dup = await execute('summarize_player_scores', args, { requestFn: pages(60, [first, first.slice(0, 10)]) });
  assert.equal(dup.coverage.complete, false);
  assert.equal(dup.duplicateCount, 10);
  const empty = await execute('summarize_player_scores', args, { requestFn: pages(0, [[]]) });
  assert.equal(empty.coverage.complete, true);
  const changing = await execute('summarize_player_scores', args, { requestFn: async (path, query) => pages(query.page === 1 ? 60 : 59, [first, second.slice(0, 9)])(path, query) });
  assert.equal(changing.coverage.totalChanged, true);
  assert.equal(changing.coverage.complete, false);
});

test('默认玩家与历史排序、精简输出', async () => {
  let requested;
  const profile = await execute('get_player', {}, { defaultPlayer: '123', requestFn: async path => {
    requested = path; return { data: { id: '123', name: 'Test', richBio: 'untrusted' }, source: 'test', fetchedAt: 'now' };
  } });
  assert.equal(requested, '/player/123');
  assert.equal(profile.player.richBio, undefined);
  const history = await execute('get_player_history', { player: '123' }, { requestFn: async () => ({ data: [{ timestamp: 2 }, { timestamp: 1 }], source: 'test' }) });
  assert.equal(history.history[0].timestamp, 1);
  assert.equal(compactScore(score(1, 0.95)).url, 'https://beatleader.com/leaderboard/global/map1');
});
