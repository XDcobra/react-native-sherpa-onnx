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
import { attachSegmentationEngine } from '../../segment';
import { getPipelineTextBufferInfo } from '../../textbuffer';
import { createStreamingTTS } from '../streaming';

describe('streaming tts mode 3 (no segmentation attach)', () => {
  const native = SherpaOnnx as unknown as {
    initializeTts: jest.Mock;
    startTtsPipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    flushStreamingPipeline: jest.Mock;
    resetStreamingPipeline: jest.Mock;
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
    native.startTtsPipeline.mockResolvedValue({ pipelineId: 'tts_pipe_1' });
    native.stopStreamingPipeline.mockResolvedValue(undefined);
    native.flushStreamingPipeline.mockResolvedValue(undefined);
    native.resetStreamingPipeline.mockResolvedValue(undefined);
    native.getStreamingPipelineStatus.mockResolvedValue({ isRunning: true });
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
  });

  it('starts pipeline directly when segmentation mode is off/default', async () => {
    const tts = await createStreamingTTS({
      modelPath: { type: 'file', path: '/models/tts' },
    });

    const handle = await tts.synthesize('txt_live_in', 'live_out');

    expect(attachSegmentationEngine).not.toHaveBeenCalled();
    expect(native.startTtsPipeline).toHaveBeenCalledWith(
      expect.stringMatching(/^streaming_tts_/),
      'txt_live_in',
      'live_out',
      undefined
    );

    await handle.flush();
    await handle.reset();
    await handle.stop();

    expect(native.flushStreamingPipeline).toHaveBeenCalledWith('tts_pipe_1');
    expect(native.resetStreamingPipeline).toHaveBeenCalledWith('tts_pipe_1');
    expect(native.stopStreamingPipeline).toHaveBeenCalledWith('tts_pipe_1');
  });

  it('treats manual mode as no-attach path', async () => {
    const tts = await createStreamingTTS({
      modelPath: { type: 'file', path: '/models/tts' },
    });

    const handle = await tts.synthesize('txt_live_in', 'live_out', {
      segmentation: { mode: 'manual' },
    });

    expect(attachSegmentationEngine).not.toHaveBeenCalled();
    expect(native.startTtsPipeline).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it('rejects segmentation policy when mode is off or manual', async () => {
    const tts = await createStreamingTTS({
      modelPath: { type: 'file', path: '/models/tts' },
    });

    await expect(
      tts.synthesize('txt_live_in', 'live_out', {
        segmentation: {
          mode: 'off',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    await expect(
      tts.synthesize('txt_live_in', 'live_out', {
        segmentation: {
          mode: 'manual',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(attachSegmentationEngine).not.toHaveBeenCalled();
    expect(native.startTtsPipeline).not.toHaveBeenCalled();
  });
});
