import {
  buildHypothesisTokenSpans,
  normalizeComparableToken,
  tokenizeReferenceText,
} from '../normalize';

describe('linker/normalize', () => {
  test('normalizes comparable token', () => {
    expect(normalizeComparableToken(' Hello,  ')).toBe('hello');
    expect(normalizeComparableToken('foo-bar')).toBe('foobar');
  });

  test('tokenizes reference text with word granularity', () => {
    const tokens = tokenizeReferenceText('Hello, world! 42', 'word');
    expect(tokens).toEqual([
      {
        raw: 'Hello',
        normalized: 'hello',
        startCharIndex: 0,
        endCharIndex: 5,
      },
      {
        raw: 'world',
        normalized: 'world',
        startCharIndex: 7,
        endCharIndex: 12,
      },
      {
        raw: '42',
        normalized: '42',
        startCharIndex: 14,
        endCharIndex: 16,
      },
    ]);
  });

  test('builds hypothesis spans from tokens and timestamps', () => {
    const spans = buildHypothesisTokenSpans(['hello', 'world'], [0, 0.5, 1.0]);
    expect(spans).toEqual([
      {
        raw: 'hello',
        normalized: 'hello',
        index: 0,
        startMs: 0,
        endMs: 500,
        startCharIndex: 0,
        endCharIndex: 5,
      },
      {
        raw: 'world',
        normalized: 'world',
        index: 1,
        startMs: 500,
        endMs: 1000,
        startCharIndex: 6,
        endCharIndex: 11,
      },
    ]);
  });
});
