jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeTts: jest.fn(),
    startTtsPipeline: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
    unloadTts: jest.fn(),
    getTtsSampleRate: jest.fn(),
    getTtsNumSpeakers: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/tts'),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
  getPipelineTextBufferInfo: jest.fn(),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
  getPipelineAudioBufferInfo: jest.fn(),
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../segment', () => ({
  attachSegmentationEngine: jest.fn(),
  detachSegmentationEngine: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { getPipelineAudioBufferInfo } from '../../audiobuffer';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
} from '../../segment';
import { getPipelineTextBufferInfo } from '../../textbuffer';
import { createStreamingTTS } from '../streaming';

describe('streaming tts mode 4 (segmentation attach)', () => {
  const native = SherpaOnnx as unknown as {
    initializeTts: jest.Mock;
    startTtsPipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    getStreamingPipelineStatus: jest.Mock;
    unloadTts: jest.Mock;
    getTtsSampleRate: jest.Mock;
    getTtsNumSpeakers: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeTts.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'vits', modelDir: '/models/tts' }],
    });
    native.startTtsPipeline.mockResolvedValue({ pipelineId: 'tts_pipe_2' });
    native.stopStreamingPipeline.mockResolvedValue(undefined);
    native.getStreamingPipelineStatus.mockResolvedValue({ isRunning: false });
    native.unloadTts.mockResolvedValue(undefined);
    native.getTtsSampleRate.mockResolvedValue(22050);
    native.getTtsNumSpeakers.mockResolvedValue(1);

    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'txt_live_in',
      kind: 'liveTextBuffer',
      state: 'recording',
      totalCharsWritten: 0,
      revision: 0,
      segmentCount: 0,
      spool: { mode: 'on', enabled: true, ready: true, bytes: 0 },
    });
    (getPipelineAudioBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'live_out',
      kind: 'livePcmBuffer',
      state: 'recording',
      sampleRate: 22050,
      channelCount: 1,
      numSamples: 0,
      durationMs: 0,
      totalSamplesWritten: 0,
      ringEvictedSamples: 0,
      hasActiveSpool: true,
    });

    (attachSegmentationEngine as jest.Mock).mockResolvedValue({
      engineId: 'seg_tts_1',
    });
    (detachSegmentationEngine as jest.Mock).mockResolvedValue(undefined);
  });

  it('attaches default text segmentation in auto mode and detaches on stop', async () => {
    const tts = await createStreamingTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const handle = await tts.synthesize('txt_live_in', 'live_out', {
      segmentation: { mode: 'auto' },
    });

    expect(attachSegmentationEngine).toHaveBeenCalledWith('txt_live_in', {
      policy: {
        evaluator: 'text_synthetic_auto',
        sentenceBoundary: true,
        maxLengthChars: 500,
      },
    });

    await handle.stop();

    expect(detachSegmentationEngine).toHaveBeenCalledWith('seg_tts_1', {
      flushFinal: true,
    });
  });

  it('rejects non-text segmentation policy and missing punctuationInstanceId', async () => {
    const tts = await createStreamingTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    await expect(
      tts.synthesize('txt_live_in', 'live_out', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'continuous_frames' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    await expect(
      tts.synthesize('txt_live_in', 'live_out', {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'text_punctuation_assisted' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(native.startTtsPipeline).not.toHaveBeenCalled();
  });

  it('rejects non-live buffer kinds', async () => {
    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValueOnce({
      bufferId: 'txt_off_in',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 10,
      tokenCount: 0,
      timestampCount: 0,
      durationCount: 0,
      hasLang: false,
      hasEmotion: false,
      hasEvent: false,
    });

    const tts = await createStreamingTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    await expect(tts.synthesize('txt_off_in', 'live_out')).rejects.toThrow(
      'input buffer must be txt_live'
    );

    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'txt_live_in',
      kind: 'liveTextBuffer',
      state: 'recording',
      totalCharsWritten: 0,
      revision: 0,
      segmentCount: 0,
      spool: { mode: 'on', enabled: true, ready: true, bytes: 0 },
    });
    (getPipelineAudioBufferInfo as jest.Mock).mockResolvedValueOnce({
      bufferId: 'off_out',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 22050,
      channelCount: 1,
      numSamples: 0,
      durationMs: 0,
    });

    await expect(tts.synthesize('txt_live_in', 'off_out')).rejects.toThrow(
      'output buffer must be live_'
    );
  });
});
