jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment.onnx' },
    }),
    alignAccurateFromPcm: jest.fn().mockResolvedValue({
      subtitles: [{ text: 'hello', start: 0, end: 0.001 }],
      timingMode: 'accurate',
    }),
  },
}));

jest.mock('../../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment-bundle'),
}));

jest.mock('../../../detect', () => ({
  resolveFileSourceForModelInit: jest
    .fn()
    .mockResolvedValue('/resolved/alignment-bundle'),
}));

jest.mock('../../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((id: string) => id),
  getPipelineAudioBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'off_audio',
    kind: 'offlinePcmBuffer',
    state: 'immutable',
    sampleRate: 16000,
    channelCount: 1,
    numSamples: 32000,
    durationMs: 2000,
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
  getOfflineTextBufferTextSlice: jest.fn().mockResolvedValue('hello world'),
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
  getOfflineSegmentBufferSegments: jest.fn(),
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
  runLinker: jest.fn(),
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';
import { runAccurateAsrMediated } from '../driver';

const linker = jest.requireMock('../../linker/linker') as {
  runLinker: jest.Mock;
};

const native = SherpaOnnx as unknown as {
  alignAccurateFromPcm: jest.Mock;
};

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  getOfflineSegmentBufferSegments: jest.Mock;
};

describe('asrMediated/driver options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects when anchor buffer has no speech anchors', async () => {
    linker.runLinker.mockResolvedValue({
      version: 0,
      status: 'ok',
      mappingUnits: [
        {
          anchorSegmentId: 'seg_anchor_0',
          anchorStartSample: 0,
          anchorEndSample: 100,
          referenceStartToken: 0,
          referenceEndToken: 1,
          refRange: { startCharIndex: 0, endCharIndex: 5 },
          hypRange: { startCharIndex: 0, endCharIndex: 5 },
          audioRangeMs: { startMs: 0, endMs: 100 },
          confidence: 0.9,
        },
      ],
      globalConfidence: 0.9,
    });
    segmentbuffer.getOfflineSegmentBufferSegments.mockResolvedValue([]);

    await expect(
      runAccurateAsrMediated({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        hypothesisTextBuffer: 'txt_hyp',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_LINKER_INPUT_INVALID' });
  });

  test('rejects when linker returns no mapping units', async () => {
    linker.runLinker.mockResolvedValue({
      version: 0,
      status: 'warning',
      mappingUnits: [],
      globalConfidence: 0,
      warnings: [],
      diagnostics: {},
    });

    await expect(
      runAccurateAsrMediated({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        hypothesisTextBuffer: 'txt_hyp',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_LINKER_NO_MAPPING' });
  });

  test('propagates ALIGNMENT_NATIVE_ACCURATE_FAILED from native accurate calls', async () => {
    const onProgress = jest.fn();

    linker.runLinker.mockResolvedValue({
      version: 0,
      status: 'ok',
      mappingUnits: [
        {
          anchorSegmentId: 'seg_anchor_0',
          anchorStartSample: 0,
          anchorEndSample: 100,
          referenceStartToken: 0,
          referenceEndToken: 1,
          refRange: { startCharIndex: 0, endCharIndex: 5 },
          hypRange: { startCharIndex: 0, endCharIndex: 5 },
          audioRangeMs: { startMs: 0, endMs: 100 },
          confidence: 0.9,
        },
      ],
      globalConfidence: 0.9,
    });
    segmentbuffer.getOfflineSegmentBufferSegments.mockResolvedValueOnce([
      {
        id: 'seg_anchor_0',
        kind: 'speech',
        sourceAudioBufferId: 'off_audio',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
      },
    ]);
    native.alignAccurateFromPcm.mockRejectedValueOnce(
      Object.assign(
        new Error('ALIGNMENT_NATIVE_ACCURATE_FAILED: native inference failed'),
        {
          code: 'ALIGNMENT_NATIVE_ACCURATE_FAILED',
        }
      )
    );

    await expect(
      runAccurateAsrMediated({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        hypothesisTextBuffer: 'txt_hyp',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
        onProgress,
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_NATIVE_ACCURATE_FAILED' });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSegment: 0,
        totalSegments: 1,
        fraction: 0,
        currentSegmentDurationMs: 1000,
      })
    );
    const progressCallOrder = onProgress.mock.invocationCallOrder[0];
    const nativeCallOrder =
      native.alignAccurateFromPcm.mock.invocationCallOrder[0];

    expect(progressCallOrder).toBeDefined();
    expect(nativeCallOrder).toBeDefined();
    expect(progressCallOrder!).toBeLessThan(nativeCallOrder!);
  });
});
