jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment.onnx' },
    }),
    alignAccurateForcedCtcFromPcm: jest.fn(),
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
  getOfflineAudioBufferSamplesSlice: jest.fn(() => new Float32Array(3200)),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'txt_ref',
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: 32,
  }),
  getOfflineTextBufferTextSlice: jest
    .fn()
    .mockResolvedValue('alpha beta gamma delta epsilon'),
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
  }),
  appendLiveSegment: jest.fn().mockResolvedValue({
    segmentId: 'seg_align_0',
    segmentIndex: 0,
  }),
  finalizeLiveSegmentBuffer: jest.fn().mockResolvedValue(undefined),
  populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../segment', () => ({
  createSegmentLinkMap: jest
    .fn()
    .mockResolvedValue({ linkMapId: 'slm_chunked_1' }),
  addSegmentLink: jest.fn().mockResolvedValue({ linkId: 'lnk_1' }),
  releaseSegmentLinkMap: jest.fn().mockResolvedValue(undefined),
}));

import { runAccurateChunkedForcedCtc } from '../driver';
import SherpaOnnx from '../../../NativeSherpaOnnx';

const native = SherpaOnnx as unknown as {
  alignAccurateForcedCtcFromPcm: jest.Mock;
};
const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  getPipelineSegmentBufferInfo: jest.Mock;
  createLiveSegmentBuffer: jest.Mock;
  finalizeLiveSegmentBuffer: jest.Mock;
  populateOfflineSegmentBufferIfEmpty: jest.Mock;
  releasePipelineSegmentBuffer: jest.Mock;
};
const segment = jest.requireMock('../../../segment') as {
  createSegmentLinkMap: jest.Mock;
  releaseSegmentLinkMap: jest.Mock;
};

const cancelled = { name: 'AbortError', code: 'ORCHESTRATION_CANCELLED' };
const tokens = {
  tokens: [{ text: 'alpha', startMs: 0, endMs: 80 }],
  consumedTokenCount: 1,
  diagnostics: { ctcBlankRatio: 0.1, framesProcessed: 3200 },
};

function run(signal: AbortSignal, onProgress?: jest.Mock) {
  return runAccurateChunkedForcedCtc({
    textIn: 'txt_ref',
    audioIn: 'off_audio',
    segmentOut: 'seg_out',
    anchorSegmentBuffer: 'seg_anchor',
    model: { modelSource: { kind: 'fs', path: '/m' } },
    granularity: 'word',
    language: 'en',
    signal,
    ...(onProgress ? { onProgress } : {}),
  });
}

describe('chunkedForcedCtc/driver cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    native.alignAccurateForcedCtcFromPcm.mockResolvedValue(tokens);
    segment.createSegmentLinkMap.mockResolvedValue({
      linkMapId: 'slm_chunked_1',
    });
  });

  test('rejects before reading any buffer when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(run(controller.signal)).rejects.toMatchObject(cancelled);
    expect(segmentbuffer.getPipelineSegmentBufferInfo).not.toHaveBeenCalled();
    expect(segmentbuffer.createLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(segment.createSegmentLinkMap).not.toHaveBeenCalled();
    expect(native.alignAccurateForcedCtcFromPcm).not.toHaveBeenCalled();
  });

  test('stops between anchors, releases temporaries and leaves segmentOut empty', async () => {
    const controller = new AbortController();
    const onProgress = jest.fn();
    native.alignAccurateForcedCtcFromPcm.mockImplementationOnce(async () => {
      controller.abort();
      return tokens;
    });

    await expect(run(controller.signal, onProgress)).rejects.toMatchObject(
      cancelled
    );

    expect(native.alignAccurateForcedCtcFromPcm).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(segment.releaseSegmentLinkMap).toHaveBeenCalledWith({
      linkMapId: 'slm_chunked_1',
    });
    expect(segmentbuffer.releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      'seg_live_out'
    );
    expect(segmentbuffer.finalizeLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(
      segmentbuffer.populateOfflineSegmentBufferIfEmpty
    ).not.toHaveBeenCalled();
  });

  test('stops before retrying the same anchor', async () => {
    const controller = new AbortController();
    native.alignAccurateForcedCtcFromPcm.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('ALIGNMENT_FORCED_CTC_FAILED: no alignable tokens');
    });

    await expect(run(controller.signal)).rejects.toMatchObject(cancelled);
    expect(native.alignAccurateForcedCtcFromPcm).toHaveBeenCalledTimes(1);
    expect(segment.releaseSegmentLinkMap).toHaveBeenCalledTimes(1);
  });

  test('keeps the link map of a finished run', async () => {
    const out = await run(new AbortController().signal);

    expect(out.linkMap).toEqual({ linkMapId: 'slm_chunked_1' });
    expect(segment.releaseSegmentLinkMap).not.toHaveBeenCalled();
  });
});
