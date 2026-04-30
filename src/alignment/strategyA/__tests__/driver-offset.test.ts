jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignOfflineTextToAudio: jest.fn().mockResolvedValue({
      outputSegmentBufferId: 'seg_tmp_out',
      segmentsWritten: 1,
    }),
  },
}));

jest.mock('../../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment.onnx'),
}));

jest.mock('../../../audiobuffer', () => ({
  resolveOfflineAudioBufferId: jest.fn((id: string) => id),
  getPipelineAudioBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'off_audio',
    kind: 'offlinePcmBuffer',
    state: 'immutable',
    sampleRate: 16000,
    channelCount: 1,
    numSamples: 64000,
    durationMs: 4000,
  }),
  getOfflineAudioBufferSamplesSlice: jest.fn(() => new Float32Array(160)),
  createOfflineAudioBufferFromSamples: jest.fn(() => ({
    bufferId: 'off_tmp_audio',
    info: {
      bufferId: 'off_tmp_audio',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 160,
      durationMs: 10,
    },
  })),
  releasePipelineAudioBuffer: jest.fn().mockResolvedValue(undefined),
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
      tokenCount: 2,
      timestampCount: 3,
    });
  }),
  getOfflineTextBufferTextSlice: jest.fn().mockResolvedValue('hello world'),
  createOfflineTextBufferFromText: jest.fn().mockResolvedValue({
    bufferId: 'txt_tmp',
    info: {
      bufferId: 'txt_tmp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 5,
      tokenCount: 0,
      timestampCount: 0,
      durationCount: 0,
      hasLang: false,
      hasEmotion: false,
      hasEvent: false,
    },
  }),
  releasePipelineTextBuffer: jest.fn().mockResolvedValue(undefined),
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
  getOfflineSegmentBufferSegments: jest.fn((bufferId: string) => {
    if (bufferId === 'seg_anchor') {
      return Promise.resolve([
        {
          id: 'seg_anchor_0',
          kind: 'speech',
          sourceAudioBufferId: 'off_audio',
          startSample: 1000,
          endSample: 1400,
          sampleRate: 16000,
          durationMs: 25,
        },
      ]);
    }

    return Promise.resolve([
      {
        id: 'seg_local_0',
        kind: 'alignment',
        sourceAudioBufferId: 'off_tmp_audio',
        startSample: 10,
        endSample: 30,
        sampleRate: 16000,
        durationMs: 1.25,
        payload: {
          text: 'hello',
          timingMode: 'accurate',
          granularity: 'word',
        },
      },
    ]);
  }),
  createEmptyOfflineSegmentBuffer: jest.fn().mockResolvedValue({
    bufferId: 'seg_tmp_out',
    info: {
      bufferId: 'seg_tmp_out',
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: 0,
    },
  }),
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
    segmentId: 'seg_global_0',
    segmentIndex: 0,
  }),
  finalizeLiveSegmentBuffer: jest.fn().mockResolvedValue(undefined),
  populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../linker/linker', () => ({
  runLinker: jest.fn().mockResolvedValue({
    version: 0,
    status: 'ok',
    mappingUnits: [
      {
        anchorSegmentId: 'seg_anchor_0',
        anchorStartSample: 1000,
        anchorEndSample: 1400,
        referenceStartToken: 0,
        referenceEndToken: 1,
        refRange: { startCharIndex: 0, endCharIndex: 5 },
        hypRange: { startCharIndex: 0, endCharIndex: 5 },
        audioRangeMs: { startMs: 0, endMs: 200 },
        confidence: 0.9,
      },
    ],
    globalConfidence: 0.9,
  }),
}));

import { runAccurateStrategyA } from '../driver';

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  appendLiveSegment: jest.Mock;
};

describe('strategyA/driver offset', () => {
  test('applies anchor start offset to local accurate timestamps', async () => {
    await runAccurateStrategyA({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      hypothesisTextBuffer: 'txt_hyp',
      modelPath: { type: 'file', path: '/m' },
      granularity: 'word',
    });

    expect(segmentbuffer.appendLiveSegment).toHaveBeenCalledWith(
      'seg_live_out',
      expect.objectContaining({
        startSample: 1010,
        endSample: 1030,
      })
    );
  });
});
