jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment.onnx' },
    }),
    alignAccurateForcedCtcFromPcm: jest
      .fn()
      .mockResolvedValueOnce({
        tokens: [
          { text: 'alpha', startMs: 0, endMs: 80 },
          { text: 'beta', startMs: 100, endMs: 180 },
        ],
        consumedTokenCount: 2,
        diagnostics: { ctcBlankRatio: 0.1, framesProcessed: 3200 },
      })
      .mockResolvedValueOnce({
        tokens: [
          { text: 'gamma', startMs: 0, endMs: 70 },
          { text: 'delta', startMs: 90, endMs: 150 },
          { text: 'epsilon', startMs: 160, endMs: 220 },
        ],
        consumedTokenCount: 3,
        diagnostics: { ctcBlankRatio: 0.05, framesProcessed: 3200 },
      }),
  },
}));

jest.mock('../../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment-bundle'),
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
}));

import { runAccurateChunkedForcedCtc } from '../driver';
import SherpaOnnx from '../../../NativeSherpaOnnx';

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  appendLiveSegment: jest.Mock;
};
const native = SherpaOnnx as unknown as {
  alignAccurateForcedCtcFromPcm: jest.Mock;
};
const segment = jest.requireMock('../../../segment') as {
  createSegmentLinkMap: jest.Mock;
  addSegmentLink: jest.Mock;
};

describe('chunkedForcedCtc/driver pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    segment.createSegmentLinkMap.mockResolvedValue({
      linkMapId: 'slm_chunked_1',
    });
    segment.addSegmentLink.mockResolvedValue({ linkId: 'lnk_1' });
  });

  test('advances cursor across anchors and writes global timestamps', async () => {
    const out = await runAccurateChunkedForcedCtc({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      modelSource: { kind: 'fs', path: '/m' },
      granularity: 'word',
      language: 'en',
    });

    expect(out.outputSegmentBufferId).toBe('seg_out');
    expect(out.segmentsWritten).toBe(5);
    expect(out.linkMap).toEqual({ linkMapId: 'slm_chunked_1' });
    expect(out.warnings).toBeUndefined();

    expect(native.alignAccurateForcedCtcFromPcm).toHaveBeenNthCalledWith(
      1,
      '/resolved/alignment.onnx',
      expect.any(String),
      {
        audioBufferId: 'off_audio',
        startSample: 0,
        sampleCount: 16000,
      },
      16000,
      'word',
      'en'
    );

    expect(segmentbuffer.appendLiveSegment).toHaveBeenCalledTimes(5);
    expect(segment.createSegmentLinkMap).toHaveBeenCalledWith({
      textBufferId: 'txt_ref',
      audioBufferId: 'off_audio',
    });
    expect(segment.addSegmentLink).toHaveBeenCalledTimes(5);
    expect(segmentbuffer.appendLiveSegment).toHaveBeenNthCalledWith(
      1,
      'seg_live_out',
      expect.objectContaining({
        startSample: 0,
        endSample: 1280,
        payload: expect.objectContaining({ text: 'alpha' }),
      })
    );

    expect(segmentbuffer.appendLiveSegment).toHaveBeenNthCalledWith(
      3,
      'seg_live_out',
      expect.objectContaining({
        startSample: 16000,
        endSample: 17120,
        payload: expect.objectContaining({ text: 'gamma' }),
      })
    );
  });

  test('fails deterministically when link map creation fails', async () => {
    segment.createSegmentLinkMap.mockRejectedValueOnce(
      new Error('SEGMENT_LINK_MAP_NOT_FOUND: fail')
    );

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
        language: 'en',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_LINKER_FAILED' });
  });
});
