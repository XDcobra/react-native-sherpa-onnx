import { alignWithDtw } from '../dtw';

describe('linker/dtw', () => {
  test('aligns identical token sequences with zero cost', () => {
    const out = alignWithDtw(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(out.totalCost).toBe(0);
    expect(
      out.pairs.filter((pair) => pair.refIndex >= 0 && pair.hypIndex >= 0)
    ).toEqual([
      { refIndex: 0, hypIndex: 0, cost: 0 },
      { refIndex: 1, hypIndex: 1, cost: 0 },
      { refIndex: 2, hypIndex: 2, cost: 0 },
    ]);
  });

  test('captures deletions as unmatched reference tokens', () => {
    const out = alignWithDtw(['a', 'b', 'c'], ['a', 'c']);
    const unmatched = out.pairs.find(
      (pair) => pair.refIndex === 1 && pair.hypIndex === -1
    );
    expect(unmatched).toEqual({ refIndex: 1, hypIndex: -1, cost: 1 });
  });
});
