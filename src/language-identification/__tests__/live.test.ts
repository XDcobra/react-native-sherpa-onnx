jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeLanguageId: jest.fn(),
    identifyLanguageOffline: jest.fn(),
    labelLanguageIdOfflineSegments: jest.fn(),
    startLanguageIdOfflineLivePipeline: jest.fn(),
    unloadLanguageId: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'languageId',
      modelType: 'whisper',
      fields: [
        { key: 'encoder', required: true, description: 'Whisper encoder' },
        { key: 'decoder', required: true, description: 'Whisper decoder' },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'languageId',
      modelType: 'whisper',
      errors: [],
      missingRequired: [],
      unknownFields: [],
      fields: {},
    })),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/whisper-tiny',
    assetName: 'sherpa-onnx-whisper-tiny',
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
import { createLanguageIdentification } from '../createLanguageIdentification';
import type { LanguageIdentificationPipelineHandle } from '../streamingTypes';

describe('language identification live overload', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeLanguageId: jest.Mock;
    startLanguageIdOfflineLivePipeline: jest.Mock;
    stopStreamingPipeline: jest.Mock;
    unloadLanguageId: jest.Mock;
  };

  const LIVE_AUDIO = 'live_11111111-1111-1111-1111-111111111111';
  const LIVE_TEXT = 'txt_live_22222222-2222-2222-2222-222222222222';
  const TARGET_SEG = 'seg_live_33333333-3333-3333-3333-333333333333';
  const SEG_LIVE = 'seg_live_44444444-4444-4444-4444-444444444444';

  let completionResolve: ((value: unknown) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    completionResolve = undefined;

    mockNative.initializeLanguageId.mockResolvedValue({ success: true });
    mockNative.startLanguageIdOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'slid_live_test',
    });
    mockNative.stopStreamingPipeline.mockResolvedValue(null);
    mockNative.unloadLanguageId.mockResolvedValue(null);

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
    return createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/models/encoder.onnx' },
        decoder: { kind: 'fs', path: '/models/decoder.onnx' },
      },
    });
  }

  it('starts live pipeline with segmentation attach and optional target segment buffer', async () => {
    const engine = await createEngine();
    const handle = (await engine.identify(LIVE_AUDIO, LIVE_TEXT, {
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
    })) as LanguageIdentificationPipelineHandle;

    expect(mockAttachSegmentationEngine).toHaveBeenCalled();
    expect(mockNative.startLanguageIdOfflineLivePipeline).toHaveBeenCalledWith(
      engine.instanceId,
      LIVE_AUDIO,
      LIVE_TEXT,
      {
        attachedSegmentationEngineId: 'seg_eng_1',
        segmentLiveBufferId: SEG_LIVE,
        targetSegmentLiveBufferId: TARGET_SEG,
      }
    );
    expect(handle.pipelineId).toBe('slid_live_test');
  });

  it('maps live text commits to onSegment and onLanguageChanged transitions', async () => {
    let textOnSegment: ((event: any) => void) | undefined;
    mockSubscribeLiveTextBufferEvents.mockImplementation(
      (_id: unknown, callbacks: { onSegment?: (event: any) => void }) => {
        textOnSegment = callbacks.onSegment;
        return jest.fn();
      }
    );

    const engine = await createEngine();
    const onSegment = jest.fn();
    const onLanguageChanged = jest.fn();

    await engine.identify(LIVE_AUDIO, LIVE_TEXT, {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'speech_energy_silence',
          minSegmentMs: 1500,
        },
      },
      onSegment,
      onLanguageChanged,
    });

    textOnSegment?.({
      segment: {
        domain: 'text',
        segmentIndex: 0,
        text: 'en',
        timestamps: [0, 2],
        meta: { durationMs: 2000 },
      },
    });
    textOnSegment?.({
      segment: {
        domain: 'text',
        segmentIndex: 1,
        text: 'en',
        timestamps: [2.5, 4],
        meta: { durationMs: 1500 },
      },
    });
    textOnSegment?.({
      segment: {
        domain: 'text',
        segmentIndex: 2,
        text: 'de',
        timestamps: [5, 7],
        meta: { durationMs: 2000 },
      },
    });

    expect(onSegment).toHaveBeenCalledTimes(3);
    expect(onLanguageChanged).toHaveBeenCalledTimes(2);
    expect(onLanguageChanged).toHaveBeenNthCalledWith(1, {
      previousLang: null,
      currentLang: 'en',
      timestamp: 0,
      segmentIndex: 0,
    });
    expect(onLanguageChanged).toHaveBeenNthCalledWith(2, {
      previousLang: 'en',
      currentLang: 'de',
      timestamp: 5,
      segmentIndex: 2,
    });
  });

  it('detaches segmentation on stop', async () => {
    const engine = await createEngine();
    const handle = (await engine.identify(LIVE_AUDIO, LIVE_TEXT, {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'speech_energy_silence', minSegmentMs: 1500 },
      },
    })) as LanguageIdentificationPipelineHandle;

    const stopPromise = handle.stop();
    completionResolve?.({
      pipelineId: 'slid_live_test',
      reason: 'stopped',
      chunksProcessed: 1,
      unitsRead: 1,
      unitsWritten: 1,
    });
    await stopPromise;

    expect(mockNative.stopStreamingPipeline).toHaveBeenCalledWith(
      'slid_live_test'
    );
    expect(mockDetachSegmentationEngine).toHaveBeenCalled();
  });

  it('rejects live identify without live text buffer', async () => {
    const engine = await createEngine();
    await expect(
      engine.identify(
        LIVE_AUDIO as any,
        {
          segmentation: { mode: 'auto' },
        } as any
      )
    ).rejects.toThrow(/liveText/);
  });
});
