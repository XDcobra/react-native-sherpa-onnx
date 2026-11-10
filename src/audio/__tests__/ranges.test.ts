import { normalizeAudioTimeRanges } from '../ranges';
import { AudioSaveErrorCode } from '../types';

describe('normalizeAudioTimeRanges', () => {
  it('returns undefined for omitted or empty ranges', () => {
    expect(normalizeAudioTimeRanges(undefined)).toBeUndefined();
    expect(normalizeAudioTimeRanges(null)).toBeUndefined();
    expect(normalizeAudioTimeRanges([])).toBeUndefined();
  });

  it('rejects NaN and inverted ranges', () => {
    expect(() =>
      normalizeAudioTimeRanges([{ startMs: Number.NaN, endMs: 10 }])
    ).toThrow(AudioSaveErrorCode.INVALID_RANGE);
    expect(() =>
      normalizeAudioTimeRanges([{ startMs: 10, endMs: 10 }])
    ).toThrow(AudioSaveErrorCode.INVALID_RANGE);
    expect(() =>
      normalizeAudioTimeRanges([{ startMs: 20, endMs: 10 }])
    ).toThrow(AudioSaveErrorCode.INVALID_RANGE);
  });

  it('sorts and merges overlapping and touching ranges', () => {
    expect(
      normalizeAudioTimeRanges([
        { startMs: 100, endMs: 200 },
        { startMs: 50, endMs: 80 },
        { startMs: 180, endMs: 250 },
        { startMs: 250, endMs: 300 },
      ])
    ).toEqual([
      { startMs: 50, endMs: 80 },
      { startMs: 100, endMs: 300 },
    ]);
  });
});
