import {
  resolveSegmentationPolicy,
  detectBoundaries,
  type ResolvedSegmentationPolicy,
} from '../segmenter';

describe('resolveSegmentationPolicy', () => {
  it('applies defaults when no policy provided', () => {
    const p = resolveSegmentationPolicy();
    expect(p.maxCharsPerSegment).toBe(500);
    expect(p.maxWaitMs).toBe(2000);
    expect(p.minCharsPerSegment).toBe(20);
    expect(p.debounceMs).toBe(100);
    expect(p.boundaryChars.has('.')).toBe(true);
    expect(p.boundaryChars.has('!')).toBe(true);
    expect(p.boundaryChars.has('?')).toBe(true);
  });

  it('respects custom boundary chars', () => {
    const p = resolveSegmentationPolicy({ boundaryChars: '|#' });
    expect(p.boundaryChars.has('|')).toBe(true);
    expect(p.boundaryChars.has('#')).toBe(true);
    expect(p.boundaryChars.has('.')).toBe(false);
  });
});

describe('detectBoundaries', () => {
  let policy: ResolvedSegmentationPolicy;

  beforeEach(() => {
    policy = resolveSegmentationPolicy({
      minCharsPerSegment: 5,
      maxCharsPerSegment: 50,
    });
  });

  it('returns empty for empty buffer', () => {
    expect(detectBoundaries('', policy)).toEqual([]);
  });

  it('returns forced boundary for entire buffer', () => {
    const result = detectBoundaries('Hello world', policy, { forced: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('Hello world');
    expect(result[0]!.remainder).toBe('');
    expect(result[0]!.reason).toBe('forced');
  });

  it('returns timeout reason when specified', () => {
    const result = detectBoundaries('Hello world', policy, {
      forced: true,
      reason: 'timeout',
    });
    expect(result[0]!.reason).toBe('timeout');
  });

  it('detects punctuation boundary', () => {
    const result = detectBoundaries('Hello world. How are you?', policy);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.text).toBe('Hello world.');
    expect(result[0]!.reason).toBe('punctuation');
  });

  it('does not split below minCharsPerSegment', () => {
    const result = detectBoundaries('Hi. World', policy);
    // "Hi." is only 3 chars, below minCharsPerSegment=5
    expect(result).toHaveLength(0);
  });

  it('splits at max-length when no boundary found', () => {
    const longText = 'a'.repeat(60);
    const result = detectBoundaries(longText, policy);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.reason).toBe('max-length');
    expect(result[0]!.text.length).toBeLessThanOrEqual(50);
  });

  it('prefers boundary char near max-length limit', () => {
    // 40 chars + ". " + 20 chars = 62 chars total, over 50 limit
    const text = 'a'.repeat(30) + '. ' + 'b'.repeat(30);
    const result = detectBoundaries(text, policy);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.text).toContain('.');
  });

  it('does not split numbers like 3.14', () => {
    const text = 'The value is 3.14 and it is great stuff here';
    const result = detectBoundaries(text, policy);
    // "3.14" has no trailing whitespace after '.', so no split there
    expect(result).toHaveLength(0);
  });

  it('handles multiple sentences', () => {
    const text = 'First sentence. Second one.';
    const result = detectBoundaries(text, policy);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.text).toBe('First sentence.');
  });

  it('handles CJK punctuation', () => {
    const p = resolveSegmentationPolicy({ minCharsPerSegment: 3 });
    const text = 'こんにちは。世界';
    const result = detectBoundaries(text, p);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.text).toBe('こんにちは。');
  });

  it('handles newline as boundary', () => {
    const p = resolveSegmentationPolicy({ minCharsPerSegment: 3 });
    const text = 'Hello world\nSecond line';
    const result = detectBoundaries(text, p);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
