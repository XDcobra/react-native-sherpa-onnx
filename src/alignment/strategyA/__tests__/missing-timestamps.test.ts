jest.mock('../../linker/linker', () => ({
  runLinker: jest.fn().mockRejectedValue(
    Object.assign(new Error('missing timestamps'), {
      code: 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS',
    })
  ),
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
    numSamples: 64000,
    durationMs: 4000,
  }),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn(() =>
    Promise.resolve({
      bufferId: 'txt_ref',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 5,
    })
  ),
  getOfflineTextBufferTextSlice: jest.fn().mockResolvedValue('hello'),
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
  createLiveSegmentBuffer: jest.fn(),
  appendLiveSegment: jest.fn(),
  finalizeLiveSegmentBuffer: jest.fn(),
  populateOfflineSegmentBufferIfEmpty: jest.fn(),
  releasePipelineSegmentBuffer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignAccurateFromPcm: jest.fn(),
  },
}));

import { runAccurateStrategyA } from '../driver';

describe('strategyA/missing-timestamps', () => {
  test('propagates ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS', async () => {
    await expect(
      runAccurateStrategyA({
        textIn: 'txt_ref',
        audioIn: 'off_audio',
        segmentOut: 'seg_out',
        anchorSegmentBuffer: 'seg_anchor',
        hypothesisTextBuffer: 'txt_hyp',
        modelPath: { type: 'file', path: '/m' },
        granularity: 'word',
      })
    ).rejects.toMatchObject({
      code: 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS',
    });
  });
});
