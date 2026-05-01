import { TurboModuleRegistry } from 'react-native';
import { setPartial, appendPartial, commitSegment } from '../index';
import type { TextSegment, SpeechSegment } from '../segment';
import {
  registerLiveTextSegmentation,
  registerLiveAudioSegmentation,
  releaseSegmentationStateForBuffer,
} from '../runtime-state';

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async (c: { path: string }) => c.path),
}));

jest.mock('react-native', () => {
  const mockNative = {
    setLiveTextBufferPartial: jest.fn(),
    appendLiveTextBufferPartial: jest.fn(),
    appendLiveTextSegment: jest.fn(),
    getLiveTextBufferSegmentCount: jest.fn(),
    getLiveTextBufferSegments: jest.fn(),
    attachSegmentationEngine: jest.fn(),
    detachSegmentationEngine: jest.fn(),
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
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
  getPipelineSegmentBufferInfo: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
}));

describe('segment api commit and partials', () => {
  const mockNative = TurboModuleRegistry.getEnforcing('SherpaOnnx') as any;
  const mockTextbuffer = jest.requireMock('../../textbuffer') as any;
  const mockAudiobuffer = jest.requireMock('../../audiobuffer') as any;
  const mockSegmentbuffer = jest.requireMock('../../segmentbuffer') as any;

  const LIVE_TEXT_ID = 'txt_live_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const LIVE_AUDIO_ID = 'live_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeEach(() => {
    jest.clearAllMocks();
    releaseSegmentationStateForBuffer(LIVE_TEXT_ID);
    releaseSegmentationStateForBuffer(LIVE_AUDIO_ID);

    // Default mocks to avoid "cannot read property bufferId of undefined"
    mockSegmentbuffer.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: 'seg_live_default',
    });
  });

  describe('setPartial / appendPartial', () => {
    it('calls native setLiveTextBufferPartial for live text buffers', async () => {
      await setPartial(LIVE_TEXT_ID, 'hello');
      expect(mockNative.setLiveTextBufferPartial).toHaveBeenCalledWith(
        LIVE_TEXT_ID,
        'hello'
      );
    });

    it('throws if setPartial is called with non-live-text ID', async () => {
      await expect(setPartial('txt_off_123', 'hello')).rejects.toThrow(
        'SEGMENT_INVALID_ARGUMENT'
      );
    });

    it('calls native appendLiveTextBufferPartial for live text buffers', async () => {
      await appendPartial(LIVE_TEXT_ID, ' world');
      expect(mockNative.appendLiveTextBufferPartial).toHaveBeenCalledWith(
        LIVE_TEXT_ID,
        ' world'
      );
    });

    it('throws if appendPartial is called with non-live-text ID', async () => {
      await expect(appendPartial('live_123', 'hello')).rejects.toThrow(
        'SEGMENT_INVALID_ARGUMENT'
      );
    });
  });

  describe('commitSegment (Text)', () => {
    it('throws if segmentation is off', async () => {
      registerLiveTextSegmentation(LIVE_TEXT_ID, 'off');
      await expect(commitSegment(LIVE_TEXT_ID)).rejects.toThrow(
        'SEGMENT_NOT_AVAILABLE'
      );
    });

    it('throws if partial text is empty', async () => {
      registerLiveTextSegmentation(LIVE_TEXT_ID, 'manual');
      mockTextbuffer.getLiveTextBufferPartialSlice.mockResolvedValue('');
      await expect(commitSegment(LIVE_TEXT_ID)).rejects.toThrow(
        'SEGMENT_COMMIT_FAILED'
      );
    });

    it('successfully commits text and returns segment', async () => {
      registerLiveTextSegmentation(LIVE_TEXT_ID, 'manual');
      mockTextbuffer.getLiveTextBufferPartialSlice.mockResolvedValue(
        'final text'
      );
      mockTextbuffer.getLiveTextBufferSegmentCount.mockResolvedValue(1);
      mockTextbuffer.getLiveTextBufferSegments.mockResolvedValue([
        {
          segmentId: 'seg_1',
          text: 'final text',
          segmentIndex: 0,
          source: 'append',
          meta: { __segmentReason: 'manual_commit' },
        },
      ]);

      const result = (await commitSegment(LIVE_TEXT_ID, {
        reason: 'manual_commit',
        lang: 'en',
      })) as TextSegment;

      expect(mockTextbuffer.appendLiveTextSegment).toHaveBeenCalledWith(
        LIVE_TEXT_ID,
        'final text',
        undefined,
        undefined,
        expect.objectContaining({
          __segmentReason: 'manual_commit',
          __segmentLang: 'en',
        })
      );
      expect(mockNative.setLiveTextBufferPartial).toHaveBeenCalledWith(
        LIVE_TEXT_ID,
        ''
      );
      expect(result.text).toBe('final text');
      expect(result.reason).toBe('manual_commit');
    });
  });

  describe('commitSegment (Audio)', () => {
    it('throws if segmentation is off for audio', async () => {
      registerLiveAudioSegmentation(LIVE_AUDIO_ID, 'off');
      await expect(commitSegment(LIVE_AUDIO_ID)).rejects.toThrow(
        'SEGMENT_NOT_AVAILABLE'
      );
    });

    it('throws if no uncommitted samples', async () => {
      registerLiveAudioSegmentation(LIVE_AUDIO_ID, 'manual');
      mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
        kind: 'livePcmBuffer',
        totalSamplesWritten: 0,
      });
      await expect(commitSegment(LIVE_AUDIO_ID)).rejects.toThrow(
        'SEGMENT_COMMIT_FAILED'
      );
    });

    it('successfully commits audio and returns segment', async () => {
      registerLiveAudioSegmentation(LIVE_AUDIO_ID, 'manual');
      mockAudiobuffer.getPipelineAudioBufferInfo.mockResolvedValue({
        kind: 'livePcmBuffer',
        totalSamplesWritten: 16000,
        sampleRate: 16000,
      });
      mockSegmentbuffer.createLiveSegmentBuffer.mockResolvedValue({
        bufferId: 'seg_live_1',
      });
      mockSegmentbuffer.appendLiveSegment.mockResolvedValue({
        segmentId: 'audio_seg_1',
      });
      mockSegmentbuffer.getLiveSegmentBufferSegmentCount.mockResolvedValue(1);
      mockSegmentbuffer.getLiveSegmentBufferSegments.mockResolvedValue([
        {
          id: 'audio_seg_1',
          kind: 'speech',
          startSample: 0,
          endSample: 16000,
          sampleRate: 16000,
          durationMs: 1000,
        },
      ]);

      const result = (await commitSegment(LIVE_AUDIO_ID, {
        reason: 'vad_boundary',
      })) as SpeechSegment;

      expect(mockSegmentbuffer.appendLiveSegment).toHaveBeenCalledWith(
        'seg_live_1',
        expect.objectContaining({
          startSample: 0,
          endSample: 16000,
        })
      );
      expect(result.domain).toBe('speech');
      expect(result.reason).toBe('vad_boundary');
    });
  });
});
