jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useMemo: (fn: () => unknown) => fn(),
}));

const mockText = { slice: jest.fn() };
jest.mock('../../textbuffer', () => ({
  getOfflineTextBufferTextSlice: (...a: unknown[]) => mockText.slice(...a),
}));

// Identity mapping: the locator offset is the text-buffer offset.
const mockMap = jest.fn(
  async (
    _doc: unknown,
    ranges: ReadonlyArray<readonly [number, number]>,
    _options?: unknown
  ) =>
    ranges.map(([a, b]) => ({
      from: { sectionId: 's0', blockId: 's0.b0', offset: a },
      to: { sectionId: 's0', blockId: 's0.b0', offset: b },
    }))
);
jest.mock('../api', () => ({
  mapTextRanges: (
    ...a: [unknown, ReadonlyArray<readonly [number, number]>, unknown?]
  ) => mockMap(...a),
}));

import {
  createReadAloudTimeline,
  splitWords,
  useReadAloudHighlights,
} from '../readAloud';

const DOC = { id: 'rdr_1' } as never;
const TEXT = 'Hello, big world. Second one!';
//            0123456789012345678901234567890
const TTS = {
  sampleRate: 1000, // 1 sample = 1 ms
  exact: true,
  segments: [
    {
      utf16Start: 0,
      utf16End: 18,
      startSample: 0,
      numSamples: 1000,
      skipped: false,
    },
    {
      utf16Start: 18,
      utf16End: 29,
      startSample: 1000,
      numSamples: 500,
      skipped: false,
    },
  ],
};

describe('read aloud timeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockText.slice.mockResolvedValue(TEXT);
  });

  it('splits words without surrounding punctuation', () => {
    expect(splitWords('“Hello,” she said — fine.')).toEqual([
      [1, 6],
      [9, 12],
      [13, 17],
      [20, 24],
    ]);
  });

  it('builds trimmed sentences with exact times and estimated words', async () => {
    const t = await createReadAloudTimeline(DOC, { text: 'txt', tts: TTS });
    expect(t.durationMs).toBe(1500);
    expect(t.sentences.map((s) => [s.textStart, s.textEnd])).toEqual([
      [0, 17],
      [18, 29],
    ]);
    expect(t.sentences.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [1000, 1500],
    ]);
    expect(t.words.map((w) => TEXT.slice(w.textStart, w.textEnd))).toEqual([
      'Hello',
      'big',
      'world',
      'Second',
      'one',
    ]);
    // Words fill their sentence; "Hello," gets a pause bonus over "big".
    const [hello, big, world] = t.words;
    expect(hello!.startMs).toBe(0);
    expect(world!.endMs).toBe(1000);
    expect(hello!.endMs - hello!.startMs).toBeGreaterThan(
      big!.endMs - big!.startMs
    );
    expect(t.at(1200).sentence?.index).toBe(1);
    expect(t.at(1200).word?.sentenceIndex).toBe(1);
    expect(t.at(1600)).toEqual({ sentence: null, word: null });
    // One mapping call for all units.
    expect(mockMap).toHaveBeenCalledTimes(1);
  });

  it('applies the text offset of a synthesized slice', async () => {
    const t = await createReadAloudTimeline(DOC, {
      text: 'txt',
      tts: TTS,
      textOffset: 500,
      granularity: 'sentence',
    });
    expect(t.words).toEqual([]);
    expect(t.sentences[0]!.range.from.offset).toBe(500);
    expect(t.sentences[1]!.textEnd).toBe(529);
  });

  it('reads a text slice and maps through it', async () => {
    const slice = {
      buffer: 'txt_off_slice',
      length: 29,
      from: { sectionId: 's2', blockId: 's2.b0.t0', offset: 0 },
      to: { sectionId: 's3', blockId: 's3.b0.t1', offset: 4 },
    } as never;
    mockMap.mockClear();
    const t = await createReadAloudTimeline(DOC, {
      slice,
      tts: TTS,
      textOffset: 500, // ignored with a slice
      granularity: 'sentence',
    });
    expect(mockText.slice).toHaveBeenLastCalledWith('txt_off_slice', 0, 29);
    expect(mockMap.mock.calls[0]![1]![0]).toEqual([0, 17]);
    expect(mockMap.mock.calls[0]![2]).toEqual({ slice });
    expect(t.sentences[0]!.textStart).toBe(0);
    await expect(
      createReadAloudTimeline(DOC, { tts: TTS } as never)
    ).rejects.toMatchObject({ code: 'ERR_READER_INVALID_ARGUMENT' });
  });

  it('uses aligned word times in order and keeps estimates for misses', async () => {
    const t = await createReadAloudTimeline(DOC, {
      text: 'txt',
      tts: TTS,
      granularity: 'word',
      words: {
        timing: {
          aligned: [
            { text: 'hello', startSample: 10, endSample: 300 },
            { text: 'WORLD', startSample: 600, endSample: 950 },
          ],
        },
      },
    });
    const [hello, big, world] = t.words;
    expect([hello!.startMs, hello!.endMs]).toEqual([10, 300]);
    expect([world!.startMs, world!.endMs]).toEqual([600, 950]);
    expect(big!.startMs).toBeGreaterThan(0); // estimate kept
  });

  it('accepts a custom word splitter (e.g. CJK)', async () => {
    const t = await createReadAloudTimeline(DOC, {
      text: 'txt',
      tts: TTS,
      granularity: 'word',
      words: { split: (s) => [[0, Math.min(2, s.length)]] },
    });
    expect(t.words).toHaveLength(2);
    expect(t.words[0]!.startMs).toBe(0);
    expect(t.words[0]!.endMs).toBe(1000);
  });

  it('turns the spoken units into highlights', async () => {
    const t = await createReadAloudTimeline(DOC, { text: 'txt', tts: TTS });
    const hs = useReadAloudHighlights(t, 100);
    expect(hs.map((h) => [h.id, h.style, h.follow])).toEqual([
      ['readAloud:sentence', 'background', false],
      ['readAloud:word', 'underline', true],
    ]);
    const sentenceOnly = useReadAloudHighlights(t, 100, { show: 'sentence' });
    expect(sentenceOnly).toHaveLength(1);
    expect(sentenceOnly[0]!.follow).toBe(true);
    const words = useReadAloudHighlights(t, 100, {
      show: 'word',
      wordStyle: { style: 'textColor', color: 'red' },
    });
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({
      id: 'readAloud:word',
      style: 'textColor',
      color: 'red',
      follow: true,
    });
    expect(useReadAloudHighlights(t, null)).toEqual([]);
    expect(useReadAloudHighlights(null, 100)).toEqual([]);
  });
});
