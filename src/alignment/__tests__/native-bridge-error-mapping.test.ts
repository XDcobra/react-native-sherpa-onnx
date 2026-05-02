jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/resolved/alignment.onnx' },
    }),
    alignAccurateFromPcm: jest.fn().mockResolvedValue({
      subtitles: [{ text: 'alpha', start: 0, end: 0.05 }],
      timingMode: 'accurate',
    }),
    alignAccurateForcedCtcFromPcm: jest.fn().mockResolvedValue({
      tokens: [{ text: 'alpha', startMs: 0, endMs: 50 }],
      consumedTokenCount: 1,
      diagnostics: { ctcBlankRatio: 0.1, framesProcessed: 3200 },
    }),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn().mockResolvedValue('/resolved/alignment-bundle'),
}));

jest.mock('../../audiobuffer', () => ({
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

jest.mock('../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn().mockResolvedValue({
    bufferId: 'txt_ref',
    kind: 'offlineTextBuffer',
    state: 'immutable',
    utf16Length: 10,
  }),
  getOfflineTextBufferTextSlice: jest.fn().mockResolvedValue('alpha beta'),
}));

jest.mock('../../segmentbuffer', () => ({
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
  }),
  appendLiveSegment: jest.fn().mockResolvedValue({
    segmentId: 'seg_align_0',
    segmentIndex: 0,
  }),
  finalizeLiveSegmentBuffer: jest.fn().mockResolvedValue(undefined),
  populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../segment', () => ({
  createSegmentLinkMap: jest
    .fn()
    .mockResolvedValue({ linkMapId: 'slm_native_error_1' }),
  addSegmentLink: jest.fn().mockResolvedValue({ linkId: 'lnk_native_error_1' }),
}));

jest.mock('../linker/linker', () => ({
  runLinker: jest.fn().mockResolvedValue({
    version: 0,
    status: 'ok',
    mappingUnits: [
      {
        anchorSegmentId: 'seg_anchor_0',
        anchorStartSample: 0,
        anchorEndSample: 16000,
        referenceStartToken: 0,
        referenceEndToken: 1,
        refRange: { startCharIndex: 0, endCharIndex: 5 },
        hypRange: { startCharIndex: 0, endCharIndex: 5 },
        audioRangeMs: { startMs: 0, endMs: 500 },
        confidence: 0.9,
      },
    ],
    globalConfidence: 0.9,
  }),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { runAccurateAsrMediated } from '../asrMediated/driver';
import { runAccurateChunkedForcedCtc } from '../chunkedForcedCtc/driver';

describe('alignment/native bridge error mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('propagates ALIGNMENT_MODEL_LOAD_FAILED from native accurate slice call', async () => {
    const native = SherpaOnnx as unknown as {
      alignAccurateFromPcm: jest.Mock;
    };
    native.alignAccurateFromPcm.mockRejectedValueOnce(
      Object.assign(
        new Error('ALIGNMENT_MODEL_LOAD_FAILED: model load failed'),
        {
          code: 'ALIGNMENT_MODEL_LOAD_FAILED',
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
        modelPath: { type: 'file', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_MODEL_LOAD_FAILED' });
  });

  test('propagates OFFLINE_OOM from native forced-ctc call', async () => {
    const native = SherpaOnnx as unknown as {
      alignAccurateForcedCtcFromPcm: jest.Mock;
    };
    native.alignAccurateForcedCtcFromPcm.mockRejectedValueOnce(
      Object.assign(new Error('OFFLINE_OOM: native out of memory'), {
        code: 'OFFLINE_OOM',
      })
    );

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelPath: { type: 'file', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'OFFLINE_OOM' });
  });

  test('maps unknown native forced-ctc failures to ALIGNMENT_NATIVE_UNKNOWN', async () => {
    const native = SherpaOnnx as unknown as {
      alignAccurateForcedCtcFromPcm: jest.Mock;
    };
    native.alignAccurateForcedCtcFromPcm.mockRejectedValueOnce(
      new Error('bridge crashed unexpectedly')
    );

    await expect(
      runAccurateChunkedForcedCtc({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        modelPath: { type: 'file', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_NATIVE_UNKNOWN' });
  });
});
