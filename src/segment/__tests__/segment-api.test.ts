jest.mock('react-native', () => {
  const mockNative = {
    setLiveTextBufferPartial: jest.fn(),
    appendLiveTextBufferPartial: jest.fn(),
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
  createLiveSegmentBuffer: jest.fn(),
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
  getOfflineSegmentBufferSegments: jest.fn(),
  getPipelineSegmentBufferInfo: jest.fn(),
}));

import { getSegmentBuffer, getSegmentCount, getSegments } from '../index';

describe('segment api offline integration', () => {
  const mockTextbuffer = jest.requireMock('../../textbuffer') as any;
  const mockAudiobuffer = jest.requireMock('../../audiobuffer') as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns synthesized text segment for offline text buffers', async () => {
    mockTextbuffer.getPipelineTextBufferInfo.mockResolvedValue({
      kind: 'offlineTextBuffer',
      utf16Length: 5,
    });
    mockTextbuffer.getOfflineTextBufferTextSlice.mockResolvedValue('hello');

    const segments = await getSegments(
      'txt_off_11111111-1111-1111-1111-111111111111',
      0,
      10
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      domain: 'text',
      text: 'hello',
      startOffset: 0,
      endOffset: 5,
      segmentIndex: 0,
    });
  });

  it('returns proxy segment buffer for offline audio buffers', async () => {
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
      'seg_audio_proxy_off_11111111-1111-1111-1111-111111111111'
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

  it('reports synthesized segment count for offline text and audio', async () => {
    mockTextbuffer.getPipelineTextBufferInfo.mockResolvedValue({
      kind: 'offlineTextBuffer',
      utf16Length: 2,
    });
    mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
      kind: 'offlinePcmBuffer',
      sampleRate: 16000,
      numSamples: 10,
      durationMs: 0.625,
    });

    const textCount = await getSegmentCount(
      'txt_off_11111111-1111-1111-1111-111111111111'
    );
    const audioCount = await getSegmentCount(
      'off_11111111-1111-1111-1111-111111111111'
    );

    expect(textCount).toBe(1);
    expect(audioCount).toBe(1);
  });
});
