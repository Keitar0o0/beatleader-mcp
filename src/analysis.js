const number = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 10000) / 10000;
export function median(values) {
  const sorted = values.filter(number).toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
}

export function historyChanges(history) {
  const start = history[0], end = history.at(-1);
  if (history.length < 2 || start.timestamp === end.timestamp) return { status: 'insufficient_snapshots' };
  const delta = key => number(start[key]) && number(end[key]) ? round(end[key] - start[key]) : null;
  const pp = delta('pp');
  return { status: 'available', from: start.timestamp, to: end.timestamp,
    pp, ppPercent: pp !== null && start.pp > 0 ? round(pp / start.pp * 100) : null,
    ppPercentStatus: pp === null ? 'missing_values' : start.pp > 0 ? 'available' : 'zero_baseline',
    accPp: delta('accPp'), passPp: delta('passPp'), techPp: delta('techPp'),
    rankImprovement: start.rank > 0 && end.rank > 0 ? start.rank - end.rank : null,
    countryRankImprovement: start.countryRank > 0 && end.countryRank > 0 ? start.countryRank - end.countryRank : null,
    totalPlayCount: delta('totalPlayCount'),
    averageRankedAccuracyPercentagePoints: delta('averageRankedAccuracyPercent') };
}

export function summarize(scores) {
  const unique = [...new Map(scores.map(s => [s.id, s])).values()];
  const groups = new Map();
  for (const s of unique) {
    const d = s.leaderboard?.difficulty;
    const stars = d?.stars;
    if (!d?.modeName || !d?.difficultyName || d.status == null || typeof s.modifiers !== 'string') continue;
    const band = number(stars) && stars > 0 ? `${Math.floor(stars / 2) * 2}–${Math.floor(stars / 2) * 2 + 2}` : 'Unrated';
    const key = JSON.stringify([d.modeName, d.difficultyName, d.status, s.modifiers, band]);
    if (!groups.has(key)) groups.set(key, { mode: d.modeName, difficulty: d.difficultyName, status: d.status, modifiers: s.modifiers, starsBand: band, scores: [] });
    groups.get(key).scores.push(s);
  }
  const candidates = [];
  const result = [...groups.values()].map(({ scores: items, ...group }) => {
    const valid = items.filter(s => number(s.accuracyPercent) && s.accuracyPercent >= 0 && s.accuracyPercent <= 100);
    const accuracyMedian = median(valid.map(s => s.accuracyPercent));
    // ponytail: two-star buckets only shortlist candidates; use map-feature matching when real feedback justifies it
    if (group.starsBand !== 'Unrated' && valid.length >= 5) {
      for (const s of valid) {
        const peers = valid.filter(p => p.id !== s.id);
        const baseline = median(peers.map(p => p.accuracyPercent));
        const gap = baseline - s.accuracyPercent;
        if (gap >= 0.5) candidates.push({
          scoreId: s.id, leaderboardId: s.leaderboardId ?? s.leaderboard.id,
          song: s.leaderboard.song?.name, url: s.url, group,
          accuracyPercent: round(s.accuracyPercent), peerMedianPercent: round(baseline),
          gapPercentagePoints: round(gap), peerCount: peers.length,
          reason: 'Accuracy is below the median of other scores in this group; review this map as a practice candidate',
        });
      }
    }
    return {
      ...group, sampleCount: items.length, accuracySampleCount: valid.length,
      medianAccuracyPercent: accuracyMedian === null ? null : round(accuracyMedian),
    };
  });
  const accuracies = unique.map(s => s.accuracyPercent).filter(v => number(v) && v >= 0 && v <= 100);
  return {
    sampleCount: unique.length, duplicateCount: scores.length - unique.length,
    accuracySampleCount: accuracies.length,
    medianAccuracyPercent: accuracies.length ? round(median(accuracies)) : null,
    groups: result,
    method: 'Median of valid percentages; groups match mode, difficulty, ranked status, modifiers and two-star bands',
    estimates: {
      method: 'Shortlist scores at least 0.5 percentage points below their peer median in groups with at least five valid scores',
      practiceCandidates: candidates.toSorted((a, b) => b.gapPercentagePoints - a.gapPercentagePoints).slice(0, 5),
    },
    interpretation: [
      'The overall median describes this sample; comparisons over time require matching maps and conditions',
      'Groups use mode, difficulty, ranked status, modifiers, and base star-rating bands; maps within a group can still differ',
      'Candidates reflect relative gaps within this sample; choose based on interest and experience, then validate progress through repeat plays',
      'Accuracy is shown as a percentage and differences as percentage points; distinguish base stars from difficulty with modifiers',
    ],
  };
}
