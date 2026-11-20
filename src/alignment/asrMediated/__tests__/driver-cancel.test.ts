jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment.onnx' },
    }),
    alignAccurateFromPcm: jest.fn(),
  },
}));

jest.mock('../../../utils', () => ({
  resolveBundledAssetPath: jest
    .fn()
    .mockResolvedValue('/resolved/alignment-bundle'),
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
    {
      id: 'seg_anchor_1',
      kind: 'speech',
      sourceAudioBufferId: 'off_audio',
      startSample: 16000,
      endSample: 32000,
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
    linkMapId: 'link_map_asr',
  }),
}));

jest.mock('../../../segment', () => ({
  releaseSegmentLinkMap: jest.fn().mockResolvedValue(undefined),
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';
import { runAccurateAsrMediated } from '../driver';

const native = SherpaOnnx as unknown as {
  alignAccurateFromPcm: jest.Mock;
};
const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  getPipelineSegmentBufferInfo: jest.Mock;
  createLiveSegmentBuffer: jest.Mock;
  populateOfflineSegmentBufferIfEmpty: jest.Mock;
};
const linker = jest.requireMock('../../linker/linker') as {
  runLinker: jest.Mock;
};
const segment = jest.requireMock('../../../segment') as {
  releaseSegmentLinkMap: jest.Mock;
};

const cancelled = { name: 'AbortError', code: 'ORCHESTRATION_CANCELLED' };

function run(signal: AbortSignal, onProgress?: jest.Mock) {
  return runAccurateAsrMediated({
    textIn: 'txt_ref',
    audioIn: 'off_audio',
    segmentOut: 'seg_out',
    anchorSegmentBuffer: 'seg_anchor',
    hypothesisTextBuffer: 'txt_hyp',
    model: { modelSource: { kind: 'fs', path: '/m' } },
    granularity: 'word',
    language: 'en',
    signal,
    ...(onProgress ? { onProgress } : {}),
  });
}

describe('asrMediated/driver cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    native.alignAccurateFromPcm.mockResolvedValue({
      subtitles: [{ text: 'hello world', start: 0, end: 0.01 }],
      timingMode: 'accurate',
    });
  });

  test('rejects before reading any buffer when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(run(controller.signal)).rejects.toMatchObject(cancelled);
    expect(segmentbuffer.getPipelineSegmentBufferInfo).not.toHaveBeenCalled();
    expect(linker.runLinker).not.toHaveBeenCalled();
    expect(native.alignAccurateFromPcm).not.toHaveBeenCalled();
  });

  test('stops between anchors, releases the link map and leaves segmentOut empty', async () => {
    const controller = new AbortController();
    const onProgress = jest.fn();
    native.alignAccurateFromPcm.mockImplementationOnce(async () => {
      controller.abort();
      return {
        subtitles: [{ text: 'hello world', start: 0, end: 0.01 }],
        timingMode: 'accurate',
      };
    });

    await expect(run(controller.signal, onProgress)).rejects.toMatchObject(
      cancelled
    );

    expect(native.alignAccurateFromPcm).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(segment.releaseSegmentLinkMap).toHaveBeenCalledWith('link_map_asr');
    expect(segmentbuffer.createLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(
      segmentbuffer.populateOfflineSegmentBufferIfEmpty
    ).not.toHaveBeenCalled();
  });

  test('releases the link map when a native anchor fails', async () => {
    native.alignAccurateFromPcm.mockRejectedValueOnce(
      new Error('ALIGNMENT_NATIVE_ACCURATE_FAILED: boom')
    );

    await expect(run(new AbortController().signal)).rejects.toThrow('boom');
    expect(segment.releaseSegmentLinkMap).toHaveBeenCalledWith('link_map_asr');
  });

  test('keeps the link map of a finished run', async () => {
    const out = await run(new AbortController().signal);

    expect(out.linkMap).toEqual({ linkMapId: 'link_map_asr' });
    expect(segment.releaseSegmentLinkMap).not.toHaveBeenCalled();
  });
});
