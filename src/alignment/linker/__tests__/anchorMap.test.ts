import {
  createAnchorTimings,
  findAnchorIndexForTimeMs,
  groupAssignmentsByAnchor,
} from '../anchorMap';
import type { SpeechSegmentMeta } from '../../../segmentbuffer/types';
import type { HypothesisTokenSpan, TokenSpan } from '../normalize';

const anchors: SpeechSegmentMeta[] = [
  {
    id: 'seg_a',
    kind: 'speech',
    sourceAudioBufferId: 'off_audio',
    startSample: 0,
    endSample: 14400,
    sampleRate: 16000,
    durationMs: 900,
  },
  {
    id: 'seg_b',
    kind: 'speech',
    sourceAudioBufferId: 'off_audio',
    startSample: 14400,
    endSample: 32000,
    sampleRate: 16000,
    durationMs: 1100,
  },
];

describe('linker/anchorMap', () => {
  test('finds anchor by time', () => {
    const timings = createAnchorTimings(anchors);
    expect(findAnchorIndexForTimeMs(timings, 200)).toEqual({
      anchorIndex: 0,
      ambiguous: false,
      usedNearest: false,
    });
    expect(findAnchorIndexForTimeMs(timings, 1500)).toEqual({
      anchorIndex: 1,
      ambiguous: false,
      usedNearest: false,
    });
  });

  test('groups assignments by anchor and contiguous ref tokens', () => {
    const refTokens: TokenSpan[] = [
      { raw: 'hello', normalized: 'hello', startCharIndex: 0, endCharIndex: 5 },
      {
        raw: 'world',
        normalized: 'world',
        startCharIndex: 6,
        endCharIndex: 11,
      },
      {
        raw: 'again',
        normalized: 'again',
        startCharIndex: 12,
        endCharIndex: 17,
      },
    ];
    const hypTokens: HypothesisTokenSpan[] = [
      {
        raw: 'hello',
        normalized: 'hello',
        index: 0,
        startMs: 0,
        endMs: 300,
        startCharIndex: 0,
        endCharIndex: 5,
      },
      {
        raw: 'world',
        normalized: 'world',
        index: 1,
        startMs: 350,
        endMs: 700,
        startCharIndex: 6,
        endCharIndex: 11,
      },
      {
        raw: 'again',
        normalized: 'again',
        index: 2,
        startMs: 1200,
        endMs: 1500,
        startCharIndex: 12,
        endCharIndex: 17,
      },
    ];

    const out = groupAssignmentsByAnchor(
      refTokens,
      hypTokens,
      [
        { refIndex: 0, hypIndex: 0, cost: 0 },
        { refIndex: 1, hypIndex: 1, cost: 0 },
        { refIndex: 2, hypIndex: 2, cost: 0 },
      ],
      createAnchorTimings(anchors)
    );

    expect(out.groups).toHaveLength(2);
    expect(out.groups[0]?.anchorSegmentId).toBe('seg_a');
    expect(out.groups[0]?.referenceStartToken).toBe(0);
    expect(out.groups[0]?.referenceEndToken).toBe(2);
    expect(out.groups[1]?.anchorSegmentId).toBe('seg_b');
    expect(out.groups[1]?.referenceStartToken).toBe(2);
    expect(out.groups[1]?.referenceEndToken).toBe(3);
  });
});
