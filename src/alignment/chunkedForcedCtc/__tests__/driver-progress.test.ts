jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignAccurateForcedCtcFromPcm: jest.fn().mockResolvedValue({
      tokens: [],
      consumedTokenCount: 0,
      diagnostics: { ctcBlankRatio: 1, framesProcessed: 1600 },
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
    numSamples: 16000,
    durationMs: 1000,
  }),
  getOfflineAudioBufferSamplesSlice: jest.fn(() => new Float32Array(1600)),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'txt_ref',
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: 24,
  }),
  getOfflineTextBufferTextSlice: jest
    .fn()
    .mockResolvedValue('alpha beta gamma delta'),
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
      endSample: 1600,
      sampleRate: 16000,
      durationMs: 100,
    },
  ]),
  createLiveSegmentBuffer: jest.fn().mockResolvedValue({
    bufferId: 'seg_live_out',
  }),
  appendLiveSegment: jest.fn().mockResolvedValue({
    segmentId: 'seg_align_0',
    segmentIndex: 0,
  }),
  finalizeLiveSegmentBuffer: jest.fn().mockResolvedValue(undefined),
  populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));

import { runAccurateChunkedForcedCtc } from '../driver';

describe('chunkedForcedCtc/driver progress', () => {
  test('emits no-progress and residual warnings when anchors consume nothing', async () => {
    const out = await runAccurateChunkedForcedCtc({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      modelPath: { type: 'file', path: '/m' },
      granularity: 'word',
    });

    expect(out.outputSegmentBufferId).toBe('seg_out');
    expect(out.segmentsWritten).toBe(0);
    expect(out.warningCode).toBe('ALIGNMENT_ANCHOR_NO_PROGRESS');
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ALIGNMENT_ANCHOR_NO_PROGRESS' }),
        expect.objectContaining({
          code: 'ALIGNMENT_RESIDUAL_TOKENS_REMAINING',
        }),
      ])
    );
  });
});
