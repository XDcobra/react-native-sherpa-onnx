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
  getOfflineAudioBufferSamplesSlice: jest.fn(() => new Float32Array(320)),
  createOfflineAudioBufferFromSamples: jest
    .fn()
    .mockReturnValueOnce({
      bufferId: 'off_tmp_audio_1',
      info: {
        bufferId: 'off_tmp_audio_1',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 320,
        durationMs: 20,
      },
    })
    .mockReturnValueOnce({
      bufferId: 'off_tmp_audio_2',
      info: {
        bufferId: 'off_tmp_audio_2',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 320,
        durationMs: 20,
      },
    }),
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
        utf16Length: 17,
      });
    }
    return Promise.resolve({
      bufferId: 'txt_hyp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      tokenCount: 3,
      timestampCount: 4,
    });
  }),
  getOfflineTextBufferTextSlice: jest
    .fn()
    .mockResolvedValue('hello world again'),
  createOfflineTextBufferFromText: jest
    .fn()
    .mockResolvedValueOnce({
      bufferId: 'txt_tmp_1',
      info: {
        bufferId: 'txt_tmp_1',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 11,
        tokenCount: 0,
        timestampCount: 0,
        durationCount: 0,
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
      },
    })
    .mockResolvedValueOnce({
      bufferId: 'txt_tmp_2',
      info: {
        bufferId: 'txt_tmp_2',
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
      segmentCount: 2,
    });
  }),
  getOfflineSegmentBufferSegments: jest.fn((bufferId: string) => {
    if (bufferId === 'seg_anchor') {
      return Promise.resolve([
        {
          id: 'seg_anchor_0',
          kind: 'speech',
          sourceAudioBufferId: 'off_audio',
          startSample: 0,
          endSample: 16000,
          sampleRate: 16000,
          durationMs: 1000,
        },
        {
          id: 'seg_anchor_1',
          kind: 'speech',
          sourceAudioBufferId: 'off_audio',
          startSample: 16000,
          endSample: 32000,
          sampleRate: 16000,
          durationMs: 1000,
        },
      ]);
    }

    if (bufferId === 'seg_tmp_out_1') {
      return Promise.resolve([
        {
          id: 'seg_local_1',
          kind: 'alignment',
          sourceAudioBufferId: 'off_tmp_audio_1',
          startSample: 20,
          endSample: 200,
          sampleRate: 16000,
          durationMs: 11.25,
          payload: {
            text: 'hello world',
            timingMode: 'accurate',
            granularity: 'word',
          },
        },
      ]);
    }

    return Promise.resolve([
      {
        id: 'seg_local_2',
        kind: 'alignment',
        sourceAudioBufferId: 'off_tmp_audio_2',
        startSample: 0,
        endSample: 150,
        sampleRate: 16000,
        durationMs: 9.375,
        payload: {
          text: 'again',
          timingMode: 'accurate',
          granularity: 'word',
        },
      },
    ]);
  }),
  createEmptyOfflineSegmentBuffer: jest
    .fn()
    .mockResolvedValueOnce({
      bufferId: 'seg_tmp_out_1',
      info: {
        bufferId: 'seg_tmp_out_1',
        kind: 'offlineSegmentBuffer',
        state: 'immutable',
        segmentCount: 0,
      },
    })
    .mockResolvedValueOnce({
      bufferId: 'seg_tmp_out_2',
      info: {
        bufferId: 'seg_tmp_out_2',
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
    segmentId: 'seg_global',
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
        anchorStartSample: 0,
        anchorEndSample: 16000,
        referenceStartToken: 0,
        referenceEndToken: 2,
        refRange: { startCharIndex: 0, endCharIndex: 11 },
        hypRange: { startCharIndex: 0, endCharIndex: 11 },
        audioRangeMs: { startMs: 0, endMs: 900 },
        confidence: 0.9,
      },
      {
        anchorSegmentId: 'seg_anchor_1',
        anchorStartSample: 16000,
        anchorEndSample: 32000,
        referenceStartToken: 2,
        referenceEndToken: 3,
        refRange: { startCharIndex: 12, endCharIndex: 17 },
        hypRange: { startCharIndex: 12, endCharIndex: 17 },
        audioRangeMs: { startMs: 950, endMs: 1800 },
        confidence: 0.89,
      },
    ],
    globalConfidence: 0.895,
  }),
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';
import { runAccurateStrategyA } from '../driver';

const native = SherpaOnnx as unknown as {
  alignOfflineTextToAudio: jest.Mock;
};

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  appendLiveSegment: jest.Mock;
  populateOfflineSegmentBufferIfEmpty: jest.Mock;
};

describe('strategyA/driver pipeline', () => {
  test('runs per-anchor accurate slices and aggregates deterministic output', async () => {
    const out = await runAccurateStrategyA({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      hypothesisTextBuffer: 'txt_hyp',
      modelPath: { type: 'file', path: '/m' },
      granularity: 'word',
      language: 'en',
    });

    expect(native.alignOfflineTextToAudio).toHaveBeenCalledTimes(2);
    for (const call of native.alignOfflineTextToAudio.mock.calls) {
      expect(call[1]).not.toBe('off_audio');
      expect(call[3]).toBe('accurate');
    }

    expect(
      segmentbuffer.populateOfflineSegmentBufferIfEmpty
    ).toHaveBeenCalledWith('seg_out', 'seg_live_out', 'fullIfSpooled');

    expect(segmentbuffer.appendLiveSegment).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      outputSegmentBufferId: 'seg_out',
      segmentsWritten: 2,
    });
  });
});
