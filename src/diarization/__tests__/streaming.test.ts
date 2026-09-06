import SherpaOnnx from '../../NativeSherpaOnnx';
import { createStreamingDiarization } from '../streaming';

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectDiarizationModel: jest.fn(),
    initializeStreamingDiarization: jest.fn(),
    startStreamingDiarizationPipeline: jest.fn(),
    feedStreamingDiarization: jest.fn(),
    flushStreamingDiarization: jest.fn(),
    resetStreamingDiarization: jest.fn(),
    releaseStreamingDiarization: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
  },
}));

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(
    () => new Promise(() => {})
  ),
}));

jest.mock('../../detect/validateCustomModelPaths', () => {
  const helpers = jest.requireActual(
    '../../detect/customModelPathRequirements'
  );
  return {
    ...helpers,
    getCustomModelPathRequirements: jest.fn(async () => ({
      fields: [
        { key: 'model', required: true, kind: 'file' },
        { key: 'metadata', required: false, kind: 'file' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({ ok: true })),
  };
});

jest.mock('../../detect/resolveModelInput', () => ({
  resolveModelFileSources: jest.fn(async (sources: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(sources)) {
      const path = (value as { path?: string })?.path;
      if (path) out[key] = path;
    }
    return out;
  }),
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/sortformer',
    assetName: 'sortformer-streaming',
  })),
  resolveFileSourceForModelInit: jest.fn(async (src: unknown) => {
    if (typeof src === 'object' && src && 'path' in src) {
      return (src as { path: string }).path;
    }
    return '/models/sortformer';
  }),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((val: unknown) =>
    typeof val === 'object' && val && 'id' in val
      ? (val as { id: string }).id
      : String(val)
  ),
}));

jest.mock('../../segmentbuffer', () => ({
  resolvePipelineSegmentBufferId: jest.fn((val: unknown) =>
    typeof val === 'object' && val && 'id' in val
      ? (val as { id: string }).id
      : String(val)
  ),
}));

describe('createStreamingDiarization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initializes in custom mode and exposes metadata-driven properties', async () => {
    (SherpaOnnx.initializeStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
      sampleRate: 16000,
      maxSpeakers: 4,
      feedSamples: 160000,
      strideSamples: 158720,
      latencySeconds: 10.0,
    });

    const engine = await createStreamingDiarization({
      initMode: 'custom',
      modelType: 'sortformer',
      customConfig: {
        model: { kind: 'fs', path: '/tmp/model.onnx' },
        metadata: { kind: 'fs', path: '/tmp/metadata.json' },
      },
    });

    expect(engine.sampleRate).toBe(16000);
    expect(engine.maxSpeakers).toBe(4);
    expect(engine.feedSamples).toBe(160000);
    expect(engine.strideSamples).toBe(158720);
    expect(engine.latencySeconds).toBe(10.0);

    expect(SherpaOnnx.initializeStreamingDiarization).toHaveBeenCalledWith(
      expect.stringMatching(/^diar_stream_/),
      expect.objectContaining({
        model: '/tmp/model.onnx',
        metadata: '/tmp/metadata.json',
      })
    );
  });

  it('starts streaming pipeline with zero-JS cursor-to-segment loop', async () => {
    (SherpaOnnx.initializeStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
      sampleRate: 16000,
      maxSpeakers: 4,
    });
    (
      SherpaOnnx.startStreamingDiarizationPipeline as jest.Mock
    ).mockResolvedValue({
      pipelineId: 'diar_live_12345',
    });

    const engine = await createStreamingDiarization({
      initMode: 'custom',
      modelType: 'sortformer',
      customConfig: {
        model: { kind: 'fs', path: '/tmp/model.onnx' },
      },
    });

    const handle = await engine.startPipeline('live_mic_1', 'seg_live_1', {
      chunkSize: 4096,
    });

    expect(handle.pipelineId).toBe('diar_live_12345');
    expect(SherpaOnnx.startStreamingDiarizationPipeline).toHaveBeenCalledWith(
      engine.instanceId,
      'live_mic_1',
      'seg_live_1',
      { chunkSize: 4096 }
    );
  });

  it('rejects pipeline start with invalid buffer prefixes', async () => {
    (SherpaOnnx.initializeStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
    });

    const engine = await createStreamingDiarization({
      initMode: 'custom',
      modelType: 'sortformer',
      customConfig: {
        model: { kind: 'fs', path: '/tmp/model.onnx' },
      },
    });

    await expect(
      engine.startPipeline('off_audio_1', 'seg_live_1')
    ).rejects.toThrow(/Expected live audio buffer/);

    await expect(
      engine.startPipeline('live_mic_1', 'seg_off_1')
    ).rejects.toThrow(/Expected live segment buffer/);
  });

  it('handles manual feed and flush', async () => {
    (SherpaOnnx.initializeStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
    });
    (SherpaOnnx.feedStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
      segments: [{ start: 0.1, end: 1.5, speaker: 0 }],
    });
    (SherpaOnnx.flushStreamingDiarization as jest.Mock).mockResolvedValue({
      success: true,
      segments: [{ start: 1.5, end: 2.0, speaker: 1 }],
    });

    const engine = await createStreamingDiarization({
      initMode: 'custom',
      modelType: 'sortformer',
      customConfig: {
        model: { kind: 'fs', path: '/tmp/model.onnx' },
      },
    });

    const fed = await engine.feed('off_audio_1');
    expect(fed).toEqual([{ start: 0.1, end: 1.5, speaker: 0 }]);

    const flushed = await engine.flush();
    expect(flushed).toEqual([{ start: 1.5, end: 2.0, speaker: 1 }]);
  });
});
