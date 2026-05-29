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
  getOfflineAudioBufferSamplesSlice: jest.fn(() => new Float32Array(160)),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'txt_ref',
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: 20,
  }),
  getOfflineTextBufferTextSlice: jest
    .fn()
    .mockResolvedValue('alpha beta gamma'),
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
      endSample: 1000,
      sampleRate: 16000,
      durationMs: 62.5,
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
    .mockResolvedValue({ linkMapId: 'slm_opts_1' }),
  addSegmentLink: jest.fn().mockResolvedValue({ linkId: 'lnk_opts_1' }),
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';
import { runAccurateChunkedForcedCtc } from '../driver';

const native = SherpaOnnx as unknown as {
  alignAccurateForcedCtcFromPcm: jest.Mock;
};

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  getPipelineSegmentBufferInfo: jest.Mock;
  getOfflineSegmentBufferSegments: jest.Mock;
};

describe('chunkedForcedCtc/driver options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fails when segmentOut is already populated', async () => {
    segmentbuffer.getPipelineSegmentBufferInfo.mockImplementationOnce(() =>
      Promise.resolve({
        bufferId: 'seg_anchor',
        kind: 'offlineSegmentBuffer',
        state: 'immutable',
        segmentCount: 1,
      })
    );
    segmentbuffer.getPipelineSegmentBufferInfo.mockImplementationOnce(() =>
      Promise.resolve({
        bufferId: 'seg_out',
        kind: 'offlineSegmentBuffer',
        state: 'immutable',
        segmentCount: 2,
      })
    );

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_OPTIONS_INVALID' });
  });

  test('fails when an anchor exceeds audio bounds', async () => {
    segmentbuffer.getOfflineSegmentBufferSegments.mockResolvedValueOnce([
      {
        id: 'seg_anchor_0',
        kind: 'speech',
        sourceAudioBufferId: 'off_audio',
        startSample: 0,
        endSample: 64000,
        sampleRate: 16000,
        durationMs: 4000,
      },
    ]);

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_ANCHOR_OUT_OF_RANGE' });
  });

  test('propagates ALIGNMENT_FORCED_CTC_FAILED from native forced CTC calls', async () => {
    native.alignAccurateForcedCtcFromPcm.mockRejectedValueOnce(
      Object.assign(
        new Error('ALIGNMENT_FORCED_CTC_FAILED: native forced ctc failed'),
        {
          code: 'ALIGNMENT_FORCED_CTC_FAILED',
        }
      )
    );

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelSource: { kind: 'fs', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_FORCED_CTC_FAILED' });
  });
});
