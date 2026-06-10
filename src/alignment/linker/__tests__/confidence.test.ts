import {
  computeGlobalConfidence,
  computeUnitConfidence,
  median,
} from '../confidence';

describe('linker/confidence', () => {
  test('computes high confidence for low-cost, high-overlap unit', () => {
    const confidence = computeUnitConfidence({
      meanTokenCost: 0,
      overlapRatio: 1,
      matchedTokenCount: 4,
      totalTokenCount: 4,
    });
    expect(confidence).toBe(1);
  });

  test('computes weighted global confidence', () => {
    expect(computeGlobalConfidence([1, 0.5], [3, 1])).toBe(0.875);
  });

  test('computes median for even and odd counts', () => {
    expect(median([0.2, 0.9, 0.5])).toBe(0.5);
    expect(median([0.2, 0.4, 0.8, 1])).toBe(0.6000000000000001);
  });
});
