jest.mock('react-native', () => {
  const mockNative = {
    setLiveTextBufferPartial: jest.fn(),
    appendLiveTextBufferPartial: jest.fn(),
    segmentOfflineBuffer: jest.fn(),
    attachSegmentationEngine: jest.fn(),
    detachSegmentationEngine: jest.fn(),
    getSegmentationEngineInfo: jest.fn(),
    createSegmentLinkMap: jest.fn(),
    addSegmentLink: jest.fn(),
    addSegmentLinks: jest.fn(),
    removeSegmentLink: jest.fn(),
    getSpeechSegmentsForText: jest.fn(),
    getTextSegmentsForSpeech: jest.fn(),
    getAllSegmentLinks: jest.fn(),
    getSegmentLinkCount: jest.fn(),
    getSegmentLinkMapInfo: jest.fn(),
    releaseSegmentLinkMap: jest.fn(),
  };
  return {
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
  };
});

jest.mock('../../utils', () => ({
  resolveBundledAssetPath: jest.fn(
    async (relativePath: string) => relativePath
  ),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
}));

jest.mock('../../textbuffer', () => ({
  appendLiveTextSegment: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getLiveTextBufferPartialSlice: jest.fn(),
  getLiveTextBufferSegmentCount: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
}));

jest.mock('../../segmentbuffer', () => ({
  appendLiveSegment: jest.fn(),
  createEmptyOfflineSegmentBuffer: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
  createOfflineSegmentBufferFromLive: jest.fn(),
  finalizeLiveSegmentBuffer: jest.fn(),
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
  getOfflineSegmentBufferSegments: jest.fn(),
  getPipelineSegmentBufferInfo: jest.fn(),
  releasePipelineSegmentBuffer: jest.fn(),
}));

import { attachSegmentationEngine, segmentOfflineBuffer } from '../index';
import { releaseSegmentationStateForBuffer } from '../runtime-state';

describe('segmentation engine punctuation-assisted policy', () => {
  const LIVE_TEXT_ID = 'txt_live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OFFLINE_TEXT_ID = 'txt_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const native = (jest.requireMock('react-native') as any).__mockNative;

  beforeEach(() => {
    jest.clearAllMocks();
    releaseSegmentationStateForBuffer(LIVE_TEXT_ID);
    native.attachSegmentationEngine.mockResolvedValue({
      engineId: 'seg_engine_punctuation',
      attachedBufferId: LIVE_TEXT_ID,
      domain: 'text',
      policy: {
        evaluator: 'text_punctuation_assisted',
        punctuationInstanceId: 'punc_on_1',
      },
      state: 'active',
      totalSegmentsCommitted: 0,
    });
    native.segmentOfflineBuffer.mockResolvedValue({
      bufferId: OFFLINE_TEXT_ID,
      kind: 'offlineTextBuffer',
      state: 'immutable',
      segmentCount: 2,
      segments: [],
    });
  });

  it('forwards punctuationInstanceId for live text attach', async () => {
    await attachSegmentationEngine(LIVE_TEXT_ID, {
      policy: {
        evaluator: 'text_punctuation_assisted',
        punctuationInstanceId: 'punc_on_1',
        maxLengthChars: 240,
      },
    });

    expect(native.attachSegmentationEngine).toHaveBeenCalledWith(
      LIVE_TEXT_ID,
      'text',
      expect.objectContaining({
        evaluator: 'text_punctuation_assisted',
        punctuationInstanceId: 'punc_on_1',
        maxLengthChars: 240,
      })
    );
  });

  it('forwards punctuationInstanceId for offline text segmentation', async () => {
    await segmentOfflineBuffer(OFFLINE_TEXT_ID, {
      evaluator: 'text_punctuation_assisted',
      punctuationInstanceId: 'punc_off_1',
      sentenceBoundary: true,
    });

    expect(native.segmentOfflineBuffer).toHaveBeenCalledWith(
      OFFLINE_TEXT_ID,
      'text',
      expect.objectContaining({
        evaluator: 'text_punctuation_assisted',
        punctuationInstanceId: 'punc_off_1',
      })
    );
  });
});
