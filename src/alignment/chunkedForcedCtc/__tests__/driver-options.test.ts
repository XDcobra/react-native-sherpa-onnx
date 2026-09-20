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
        model: { modelSource: { kind: 'fs', path: '/m' } },
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
        model: { modelSource: { kind: 'fs', path: '/m' } },
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
        model: { modelSource: { kind: 'fs', path: '/m' } },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_FORCED_CTC_FAILED' });
  });

  test('skips unalignable tag windows instead of aborting chunkedForcedCtc', async () => {
    const textbuffer = jest.requireMock('../../../textbuffer') as {
      getOfflineTextBufferTextSlice: jest.Mock;
    };
    textbuffer.getOfflineTextBufferTextSlice.mockResolvedValueOnce(
      '[MUSIC] [APPLAUSE] hello world'
    );

    native.alignAccurateForcedCtcFromPcm.mockResolvedValueOnce({
      tokens: [
        { text: 'hello', startMs: 0, endMs: 40 },
        { text: 'world', startMs: 50, endMs: 90 },
      ],
      consumedTokenCount: 2,
      diagnostics: { ctcBlankRatio: 0.1, framesProcessed: 1600 },
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

    const out = await runAccurateChunkedForcedCtc({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      model: { modelSource: { kind: 'fs', path: '/m' } },
      granularity: 'word',
    });

    expect(out.segmentsWritten).toBe(2);
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ALIGNMENT_UNALIGNABLE_TEXT_SKIPPED',
        }),
      ])
    );
    expect(native.alignAccurateForcedCtcFromPcm).toHaveBeenCalledTimes(1);
    expect(native.alignAccurateForcedCtcFromPcm.mock.calls[0][1]).toBe(
      'hello world'
    );
  });

  test('recovers from native no-alignable-tokens by advancing one unit', async () => {
    native.alignAccurateForcedCtcFromPcm
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'ALIGNMENT_FORCED_CTC_FAILED: Transcript has no alignable tokens for provided vocabulary'
          ),
          { code: 'ALIGNMENT_FORCED_CTC_FAILED' }
        )
      )
      .mockResolvedValueOnce({
        tokens: [{ text: 'beta', startMs: 0, endMs: 40 }],
        consumedTokenCount: 1,
        diagnostics: { ctcBlankRatio: 0.1, framesProcessed: 1600 },
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

    const out = await runAccurateChunkedForcedCtc({
      textIn: 'txt_ref',
      audioIn: 'off_audio',
      segmentOut: 'seg_out',
      anchorSegmentBuffer: 'seg_anchor',
      model: { modelSource: { kind: 'fs', path: '/m' } },
      granularity: 'word',
    });

    // Default mock text is "alpha beta gamma"; first native fail advances past "alpha".
    expect(out.segmentsWritten).toBe(1);
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ALIGNMENT_UNALIGNABLE_TEXT_SKIPPED',
        }),
      ])
    );
    expect(native.alignAccurateForcedCtcFromPcm).toHaveBeenCalledTimes(2);
  });
});
