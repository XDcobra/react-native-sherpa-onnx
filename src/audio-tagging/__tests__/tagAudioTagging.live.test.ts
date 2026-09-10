jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeAudioTagging: jest.fn(),
    tagAudioOffline: jest.fn(),
    startAudioTaggingOfflineLivePipeline: jest.fn(),
    unloadAudioTagging: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'audioTagging',
      modelType: 'ced',
      fields: [
        { key: 'model', required: true, description: 'CED model' },
        { key: 'labels', required: true, description: 'Labels CSV' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'audioTagging',
      modelType: 'ced',
      errors: [],
      missingRequired: [],
      unknownFields: [],
      fields: {},
    })),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/ced-mini',
    assetName: 'sherpa-onnx-ced-mini',
  })),
  resolveFileSourceForModelInit: jest.fn(async (source: any) => {
    if (typeof source === 'string') return source;
    return source.path ?? '/resolved/path';
  }),
  resolveModelFileSources: jest.fn(async (map: Record<string, any>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      out[k] = v.path ?? `/resolved/${k}`;
    }
    return out;
  }),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

const mockSubscribeLiveTextBufferEvents = jest.fn();
jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
  subscribeLiveTextBufferEvents: (...args: unknown[]) =>
    mockSubscribeLiveTextBufferEvents(...args),
}));

const mockAttachSegmentationEngine = jest.fn();
const mockGetSegmentationEngineInfo = jest.fn();
const mockDetachSegmentationEngine = jest.fn();
jest.mock('../../segment', () => ({
  attachSegmentationEngine: (...args: unknown[]) =>
    mockAttachSegmentationEngine(...args),
  getSegmentationEngineInfo: (...args: unknown[]) =>
    mockGetSegmentationEngineInfo(...args),
  detachSegmentationEngine: (...args: unknown[]) =>
    mockDetachSegmentationEngine(...args),
}));

const mockCreateStreamingPipelineCompletionPromise = jest.fn();
jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: (pipelineId: string) =>
    mockCreateStreamingPipelineCompletionPromise(pipelineId),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createAudioTagging } from '../createAudioTagging';
import type { AudioTaggingPipelineHandle } from '../streamingTypes';

describe('audio tagging live overload', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeAudioTagging: jest.Mock;
    startAudioTaggingOfflineLivePipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    unloadAudioTagging: jest.Mock;
  };

  const LIVE_AUDIO = 'live_11111111-1111-1111-1111-111111111111';
  const LIVE_TEXT = 'txt_live_22222222-2222-2222-2222-222222222222';
  const TARGET_SEG = 'seg_live_33333333-3333-3333-3333-333333333333';
  const SEG_LIVE = 'seg_live_44444444-4444-4444-4444-444444444444';

  let completionResolve: ((value: unknown) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    completionResolve = undefined;

    mockNative.initializeAudioTagging.mockResolvedValue({
      success: true,
      modelType: 'ced',
    });
    mockNative.startAudioTaggingOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'at_live_test',
    });
    mockNative.stopStreamingPipeline.mockResolvedValue(null);
    mockNative.unloadAudioTagging.mockResolvedValue(null);

    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_eng_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      segmentBufferId: SEG_LIVE,
      domain: 'speech',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);

    mockCreateStreamingPipelineCompletionPromise.mockImplementation(
      () =>
        new Promise((resolve) => {
          completionResolve = resolve;
        })
    );
    mockSubscribeLiveTextBufferEvents.mockImplementation(() => jest.fn());
  });

  async function createEngine() {
    return createAudioTagging({
      initMode: 'custom',
      modelType: 'ced',
      customConfig: {
        model: { kind: 'fs', path: '/models/model.int8.onnx' },
        labels: { kind: 'fs', path: '/models/class_labels_indices.csv' },
      },
    });
  }

  it('starts live pipeline with segmentation attach, target segment buffer, and topK', async () => {
    const engine = await createEngine();
    const handle = (await engine.tag(LIVE_AUDIO, LIVE_TEXT, {
      topK: 3,
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'speech_energy_silence',
          silenceThresholdMs: 500,
          energyThresholdDb: -40,
          minSegmentMs: 1500,
          maxSegmentMs: 25000,
          hangoverMs: 300,
        },
      },
      targetSegmentBuffer: TARGET_SEG,
    })) as AudioTaggingPipelineHandle;

    expect(mockAttachSegmentationEngine).toHaveBeenCalled();
    expect(
      mockNative.startAudioTaggingOfflineLivePipeline
    ).toHaveBeenCalledWith(engine.instanceId, LIVE_AUDIO, LIVE_TEXT, {
      attachedSegmentationEngineId: 'seg_eng_1',
      segmentLiveBufferId: SEG_LIVE,
      targetSegmentLiveBufferId: TARGET_SEG,
      topK: 3,
    });
    expect(handle.pipelineId).toBe('at_live_test');
  });

  it('maps live text commits to onSegment with meta.events', async () => {
    let textOnSegment: ((event: any) => void) | undefined;
    mockSubscribeLiveTextBufferEvents.mockImplementation(
      (_id: unknown, callbacks: { onSegment?: (event: any) => void }) => {
        textOnSegment = callbacks.onSegment;
        return jest.fn();
      }
    );

    const engine = await createEngine();
    const onSegment = jest.fn();

    await engine.tag(LIVE_AUDIO, LIVE_TEXT, {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 2000 },
      },
      onSegment,
    });

    textOnSegment?.({
      segment: {
        domain: 'text',
        segmentIndex: 0,
        text: 'Speech',
        timestamps: [0, 2],
        meta: {
          durationMs: 2000,
          events: [
            { name: 'Speech', index: 0, prob: 0.9 },
            { name: 'Music', index: 1, prob: 0.2 },
          ],
        },
      },
    });

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment).toHaveBeenCalledWith({
      segmentIndex: 0,
      startTime: 0,
      endTime: 2,
      durationMs: 2000,
      result: expect.objectContaining({
        primary: { name: 'Speech', index: 0, prob: 0.9 },
        events: [
          { name: 'Speech', index: 0, prob: 0.9 },
          { name: 'Music', index: 1, prob: 0.2 },
        ],
        topK: 2,
      }),
    });
  });

  it('detaches segmentation on stop', async () => {
    const engine = await createEngine();
    const handle = (await engine.tag(LIVE_AUDIO, LIVE_TEXT, {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence', minSegmentMs: 1500 },
      },
    })) as AudioTaggingPipelineHandle;

    const stopPromise = handle.stop();
    completionResolve?.({
      pipelineId: 'at_live_test',
      reason: 'stopped',
      chunksProcessed: 1,
      unitsRead: 1,
      unitsWritten: 1,
    });
    await stopPromise;

    expect(mockNative.stopStreamingPipeline).toHaveBeenCalledWith(
      'at_live_test'
    );
    expect(mockDetachSegmentationEngine).toHaveBeenCalled();
  });

  it('rejects live tag without live text buffer', async () => {
    const engine = await createEngine();
    await expect(
      engine.tag(
        LIVE_AUDIO as any,
        {
          segmentation: { mode: 'auto' },
        } as any
      )
    ).rejects.toThrow(/liveText/);
  });

  it('rejects unsupported live evaluator', async () => {
    const engine = await createEngine();
    await expect(
      engine.tag(LIVE_AUDIO, LIVE_TEXT, {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_vad_model' as any },
        },
      })
    ).rejects.toThrow();
  });
});
