jest.mock('../../utils', () => ({
  resolveBundledAssetPath: jest.fn(
    async (relativePath: string) => relativePath
  ),
}));

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

jest.mock('../../textbuffer', () => ({
  appendLiveTextSegment: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getLiveTextBufferPartialSlice: jest.fn(),
  getLiveTextBufferSegmentCount: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
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

import {
  getSegmentBuffer,
  getSegmentCount,
  getSegments,
  segmentOfflineBuffer,
} from '../index';

describe('segment api offline integration', () => {
  const mockTextbuffer = jest.requireMock('../../textbuffer') as any;
  const mockAudiobuffer = jest.requireMock('../../audiobuffer') as any;
  const mockSegmentbuffer = jest.requireMock('../../segmentbuffer') as any;

  beforeEach(() => {
    jest.clearAllMocks();
    const native = (jest.requireMock('react-native') as any).__mockNative;
    native.segmentOfflineBuffer.mockResolvedValue({
      bufferId: 'seg_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: 1,
      sourceAudioBufferId: 'off_11111111-1111-1111-1111-111111111111',
    });
    mockSegmentbuffer.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: 'seg_live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    mockSegmentbuffer.appendLiveSegment.mockResolvedValue({
      segmentId: 'segmeta_1',
      segmentIndex: 0,
    });
    mockSegmentbuffer.finalizeLiveSegmentBuffer.mockResolvedValue(undefined);
    mockSegmentbuffer.createOfflineSegmentBufferFromLive.mockResolvedValue({
      bufferId: 'seg_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    mockSegmentbuffer.releasePipelineSegmentBuffer.mockResolvedValue(undefined);
    mockSegmentbuffer.getOfflineSegmentBufferSegments.mockResolvedValue([
      {
        id: 'segmeta_1',
        kind: 'speech',
        sourceAudioBufferId: 'off_11111111-1111-1111-1111-111111111111',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
      },
    ]);
    mockSegmentbuffer.getPipelineSegmentBufferInfo.mockResolvedValue({
      kind: 'offlineSegmentBuffer',
      segmentCount: 1,
      sourceAudioBufferId: 'off_11111111-1111-1111-1111-111111111111',
    });
  });

  it('rejects offline text reads before materialization', async () => {
    mockTextbuffer.getPipelineTextBufferInfo.mockResolvedValue({
      kind: 'offlineTextBuffer',
      utf16Length: 5,
    });

    await expect(
      getSegments('txt_off_11111111-1111-1111-1111-111111111111', 0, 10)
    ).rejects.toThrow('SEGMENT_NOT_AVAILABLE');
  });

  it('materializes native offline text one-shot segments', async () => {
    const native = (jest.requireMock('react-native') as any).__mockNative;
    native.segmentOfflineBuffer.mockImplementation(
      async (_bufferId: string, domain: 'text' | 'speech') => {
        if (domain === 'text') {
          return {
            bufferId: 'txt_off_11111111-1111-1111-1111-111111111111',
            kind: 'offlineTextBuffer',
            state: 'immutable',
            segmentCount: 2,
            segments: [
              {
                segmentId:
                  'txtseg_txt_off_11111111-1111-1111-1111-111111111111_0',
                startOffset: 0,
                endOffset: 6,
                reason: 'punctuation',
                source: 'segmentation_engine',
                text: 'hello.',
              },
              {
                segmentId:
                  'txtseg_txt_off_11111111-1111-1111-1111-111111111111_1',
                startOffset: 6,
                endOffset: 11,
                reason: 'finalize',
                source: 'segmentation_engine',
                text: 'world',
              },
            ],
          };
        }

        return {
          bufferId: 'seg_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          kind: 'offlineSegmentBuffer',
          state: 'immutable',
          segmentCount: 1,
          sourceAudioBufferId: 'off_11111111-1111-1111-1111-111111111111',
        };
      }
    );

    await segmentOfflineBuffer('txt_off_11111111-1111-1111-1111-111111111111', {
      evaluator: 'text_synthetic_auto',
      sentenceBoundary: true,
      maxLengthChars: 500,
    });

    const segments = await getSegments(
      'txt_off_11111111-1111-1111-1111-111111111111',
      0,
      10
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      domain: 'text',
      text: 'hello.',
      reason: 'punctuation',
      source: 'segmentation_engine',
      startOffset: 0,
      endOffset: 6,
      segmentIndex: 0,
    });
    expect(segments[1]).toMatchObject({
      domain: 'text',
      text: 'world',
      reason: 'finalize',
      source: 'segmentation_engine',
      startOffset: 6,
      endOffset: 11,
      segmentIndex: 1,
    });
  });

  it('returns associated offline segment buffer for offline audio buffers', async () => {
    mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
      kind: 'offlinePcmBuffer',
      sampleRate: 16000,
      numSamples: 32000,
      durationMs: 2000,
    });

    const ref = await getSegmentBuffer(
      'off_11111111-1111-1111-1111-111111111111'
    );

    expect(ref.domain).toBe('speech');
    expect(ref.parentBufferId).toBe('off_11111111-1111-1111-1111-111111111111');
    expect(ref.segmentBufferId).toBe(
      'seg_off_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    );
  });

  it('returns synthesized speech segment for offline audio buffers', async () => {
    mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
      kind: 'offlinePcmBuffer',
      sampleRate: 16000,
      numSamples: 16000,
      durationMs: 1000,
    });

    const segments = await getSegments(
      'off_11111111-1111-1111-1111-111111111111',
      0,
      10
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      domain: 'speech',
      sourceAudioBufferId: 'off_11111111-1111-1111-1111-111111111111',
      startOffset: 0,
      endOffset: 16000,
      segmentIndex: 0,
    });
  });

  it('throws SEGMENT_INDEX_OUT_OF_RANGE for out-of-range reads', async () => {
    const native = (jest.requireMock('react-native') as any).__mockNative;
    native.segmentOfflineBuffer.mockResolvedValue({
      bufferId: 'txt_off_11111111-1111-1111-1111-111111111111',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      segmentCount: 1,
      segments: [
        {
          segmentId: 'txtseg_txt_off_11111111-1111-1111-1111-111111111111_0',
          startOffset: 0,
          endOffset: 5,
          reason: 'finalize',
          source: 'segmentation_engine',
          text: 'hello',
        },
      ],
    });

    await segmentOfflineBuffer('txt_off_11111111-1111-1111-1111-111111111111', {
      evaluator: 'text_synthetic_auto',
      sentenceBoundary: true,
      maxLengthChars: 500,
    });

    await expect(
      getSegments('txt_off_11111111-1111-1111-1111-111111111111', 1, 1)
    ).rejects.toThrow('SEGMENT_INDEX_OUT_OF_RANGE');
  });

  it('reports cached segment count for offline text and native count for audio', async () => {
    const textBufferId = 'txt_off_22222222-2222-2222-2222-222222222222';

    mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
      kind: 'offlinePcmBuffer',
      sampleRate: 16000,
      numSamples: 10,
      durationMs: 0.625,
    });

    await expect(getSegmentCount(textBufferId)).rejects.toThrow(
      'SEGMENT_NOT_AVAILABLE'
    );

    const native = (jest.requireMock('react-native') as any).__mockNative;
    native.segmentOfflineBuffer.mockResolvedValue({
      bufferId: textBufferId,
      kind: 'offlineTextBuffer',
      state: 'immutable',
      segmentCount: 2,
      segments: [
        {
          segmentId: `txtseg_${textBufferId}_0`,
          startOffset: 0,
          endOffset: 1,
          reason: 'punctuation',
          source: 'segmentation_engine',
          text: 'a',
        },
        {
          segmentId: `txtseg_${textBufferId}_1`,
          startOffset: 1,
          endOffset: 2,
          reason: 'finalize',
          source: 'segmentation_engine',
          text: 'b',
        },
      ],
    });

    await segmentOfflineBuffer(textBufferId, {
      evaluator: 'text_synthetic_auto',
      sentenceBoundary: true,
      maxLengthChars: 500,
    });

    const textCount = await getSegmentCount(textBufferId);
    const audioCount = await getSegmentCount(
      'off_11111111-1111-1111-1111-111111111111'
    );

    expect(textCount).toBe(2);
    expect(audioCount).toBe(1);
  });

  it('maps endpoint/source from native segment meta for live stt commits', async () => {
    mockTextbuffer.getLiveTextBufferSegmentCount.mockResolvedValue(1);
    mockTextbuffer.getLiveTextBufferSegments.mockResolvedValue([
      {
        text: 'hello world',
        source: 'stt_stream',
        segmentIndex: 0,
        meta: {
          __segmentReason: 'endpoint',
          __segmentSource: 'segmentation_engine',
          __segmentCreatedAtMs: 12345,
        },
      },
    ]);

    const segments = await getSegments(
      'txt_live_11111111-1111-1111-1111-111111111111',
      0,
      10
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      domain: 'text',
      reason: 'endpoint',
      source: 'segmentation_engine',
      text: 'hello world',
      createdAtMs: 12345,
    });
  });

  it('live text: stt_stream without __segmentReason in meta maps to manual_commit (contract: producers set meta)', async () => {
    mockTextbuffer.getLiveTextBufferSegmentCount.mockResolvedValue(1);
    mockTextbuffer.getLiveTextBufferSegments.mockResolvedValue([
      {
        text: 'orphan',
        source: 'stt_stream',
        segmentIndex: 0,
        meta: {},
      },
    ]);

    const segments = await getSegments(
      'txt_live_11111111-1111-1111-1111-111111111111',
      0,
      10
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      domain: 'text',
      reason: 'manual_commit',
      text: 'orphan',
    });
  });
});
