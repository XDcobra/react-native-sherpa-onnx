jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignAccurateFromPcm: jest.fn().mockResolvedValue({
      subtitles: [{ text: 'hello', start: 0.00125, end: 0.0075 }],
      timingMode: 'accurate',
    }),
  },
}));

jest.mock('../../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment.onnx'),
}));

jest.mock('../../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((id: string) => id),
  getPipelineAudioBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'off_audio',
    kind: 'offlinePcmBuffer',
    state: 'immutable',
    sampleRate: 16000,
    channelCount: 1,
    numSamples: 64000,
    durationMs: 4000,
  }),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn((id: string) => {
    if (id === 'txt_ref') {
      return Promise.resolve({
        bufferId: 'txt_ref',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 12,
      });
    }
    return Promise.resolve({
      bufferId: 'txt_hyp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      tokenCount: 4,
      timestampCount: 5,
    });
  }),
  getOfflineTextBufferTextSlice: jest
    .fn()
    .mockResolvedValue('hello world test'),
}));

jest.mock('../../../segmentbuffer', () => ({
  resolveOfflineSegmentBufferId: jest.fn((id: string) => id),
  getPipelineSegmentBufferInfo: jest.fn((id: string) => {
    if (id === 'seg_out') {
      return Promise.resolve({
        bufferId: 'seg_out',
        kind: 'offlineSegmentBuffer',
        state: 'immutable',
        segmentCount: 0,
      });
    }
    return Promise.resolve({
      bufferId: 'seg_anchor',
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: 1,
    });
  }),
  getOfflineSegmentBufferSegments: jest.fn().mockResolvedValue([
    {
      id: 'seg_anchor_0',
      kind: 'speech',
      sourceAudioBufferId: 'off_audio',
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
    },
  ]),
  createLiveSegmentBuffer: jest.fn().mockResolvedValue({
    bufferId: 'seg_live_out',
    info: {
      bufferId: 'seg_live_out',
      kind: 'liveSegmentBuffer',
      state: 'recording',
      segmentCount: 0,
      totalSegmentsWritten: 0,
      spool: { mode: 'off', enabled: false, ready: true, bytes: 0 },
    },
    unsubscribeEvents: jest.fn(),
  }),
  appendLiveSegment: jest.fn().mockResolvedValue({
    segmentId: 'seg_a',
    segmentIndex: 0,
  }),
  finalizeLiveSegmentBuffer: jest.fn().mockResolvedValue(undefined),
  populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../linker/linker', () => ({
  runLinker: jest.fn().mockResolvedValue({
    version: 0,
    status: 'warning',
    mappingUnits: [
      {
        anchorSegmentId: 'seg_anchor_0',
        anchorStartSample: 0,
        anchorEndSample: 16000,
        referenceStartToken: 0,
        referenceEndToken: 1,
        refRange: { startCharIndex: 0, endCharIndex: 5 },
        hypRange: { startCharIndex: 0, endCharIndex: 5 },
        audioRangeMs: { startMs: 0, endMs: 300 },
        confidence: 0.41,
      },
    ],
    globalConfidence: 0.41,
    warnings: [
      { code: 'PARTIAL_COVERAGE', message: 'coverage below 100%' },
      {
        code: 'LOW_CONFIDENCE_UNIT',
        message: 'unit confidence below threshold',
      },
    ],
  }),
}));

import { runAccurateAsrMediated } from '../driver';

describe('asrMediated/driver coverage', () => {
  test('emits non-fatal partial coverage + low-confidence warnings', async () => {
    const out = await runAccurateAsrMediated({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      hypothesisTextBuffer: 'txt_hyp',
      modelPath: { type: 'file', path: '/m' },
      granularity: 'word',
      language: 'en',
    });

    expect(out.segmentsWritten).toBe(1);
    expect(out.outputSegmentBufferId).toBe('seg_out');
    expect(out.warnings?.map((warning) => warning.code)).toEqual([
      'ALIGNMENT_PARTIAL_COVERAGE',
      'ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT',
    ]);
  });
});
