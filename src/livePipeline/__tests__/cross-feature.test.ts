import { createSTT } from '../../stt';
import { createOfflinePunctuation } from '../../punctuation';
import { createTTS } from '../../tts';
import { createEnhancement } from '../../enhancement';
import { createSeparation } from '../../separation';
import SherpaOnnx from '../../NativeSherpaOnnx';
import { LiveOfflinePipelineError } from '../validation';
import { NativeEventEmitter } from 'react-native';

const mockEmitter = {
  listeners: {} as Record<string, ((event: any) => void)[]>,
  addListener(event: string, callback: (event: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(callback);
    return {
      remove: () => {
        this.listeners[event] = this.listeners[event]!.filter(
          (cb) => cb !== callback
        );
      },
    };
  },
  emit(event: string, data: any) {
    this.listeners[event]?.forEach((cb) => cb(data));
  },
  removeAllListeners() {
    this.listeners = {};
  },
};

jest.mock('react-native', () => {
  const mockNative = {
    detectSttModel: jest.fn(),
    initializeStt: jest.fn(),
    startSttOfflineLivePipeline: jest.fn(),
    detectPunctuationModel: jest.fn(),
    initializeOfflinePunctuation: jest.fn(),
    startPunctuationOfflineLivePipeline: jest.fn(),
    detectTtsModel: jest.fn(),
    initializeTts: jest.fn(),
    startTtsOfflineLivePipeline: jest.fn(),
    detectEnhancementModel: jest.fn(),
    initializeEnhancement: jest.fn(),
    startEnhancementOfflineLivePipeline: jest.fn(),
    detectSeparationModel: jest.fn(),
    initializeSeparation: jest.fn(),
    getSeparationNumStems: jest.fn().mockResolvedValue(2),
    startSeparationOfflineLivePipeline: jest.fn(),
    unloadSeparation: jest.fn(),
    stopStreamingPipeline: jest.fn(),
    flushStreamingPipeline: jest.fn(),
    resetStreamingPipeline: jest.fn(),
    getStreamingPipelineStatus: jest.fn(),
    attachSegmentationEngine: jest
      .fn()
      .mockResolvedValue({ engineId: 'e1', segmentBufferId: 's1' }),
    detachSegmentationEngine: jest.fn(),
    getSegmentationEngineInfo: jest.fn().mockResolvedValue({
      engineId: 'e1',
      attachedBufferId: 'b1',
      domain: 'speech',
      policy: {},
      state: 'active',
      totalSegmentsCommitted: 0,
      segmentBufferId: 's1',
    }),
    unloadOfflinePunctuation: jest.fn(),
    unloadTts: jest.fn(),
    unloadStt: jest.fn(),
    unloadEnhancement: jest.fn(),
    resolveAppBaseDir: jest.fn().mockResolvedValue('/app'),
    getAssetPackPath: jest.fn().mockResolvedValue('/pad'),
  };
  return {
    NativeEventEmitter: jest.fn().mockImplementation(() => mockEmitter),
    NativeModules: { SherpaOnnx: {} },
    TurboModuleRegistry: {
      getEnforcing: jest.fn().mockReturnValue(mockNative),
    },
  };
});

jest.mock('../../NativeSherpaOnnx', () => {
  return {
    __esModule: true,
    default: jest
      .requireMock('react-native')
      .TurboModuleRegistry.getEnforcing('SherpaOnnx'),
  };
});

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/test/path',
  exists: jest.fn().mockResolvedValue(true),
  readDir: jest.fn().mockResolvedValue([]),
}));

describe('Cross-Feature Live Overload Parity (X-1 to X-4)', () => {
  const native = SherpaOnnx as jest.Mocked<typeof SherpaOnnx>;
  let emitter: any;

  beforeEach(() => {
    jest.clearAllMocks();
    emitter = new NativeEventEmitter();

    // Default success mocks for initialization
    native.detectSttModel.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.initializeStt.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.startSttOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'stt_p1',
    });

    native.detectPunctuationModel.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.initializeOfflinePunctuation.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
      modelType: 'ct_transformer',
    });
    native.startPunctuationOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'punc_p1',
    });

    native.detectTtsModel.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.initializeTts.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
      sampleRate: 16000,
      numSpeakers: 1,
    });
    native.startTtsOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'tts_p1',
    });

    native.detectEnhancementModel.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.initializeEnhancement.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
      sampleRate: 16000,
    });
    native.startEnhancementOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'enh_p1',
    });

    native.detectSeparationModel.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
    });
    native.initializeSeparation.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'm' }],
      sampleRate: 44100,
      numStems: 2,
    });
    native.startSeparationOfflineLivePipeline.mockResolvedValue({
      pipelineId: 'sep_p1',
    });

    native.getStreamingPipelineStatus.mockResolvedValue({
      pipelineId: 'p_any',
      isRunning: true,
      chunksProcessed: 0,
      unitsRead: 0,
      unitsWritten: 0,
      error: null,
    });
  });

  const factories = [
    {
      name: 'STT',
      create: () => createSTT({ modelSource: { kind: 'fs', path: 'm' } }),
    },
    {
      name: 'Punctuation',
      create: () =>
        createOfflinePunctuation({ modelSource: { kind: 'fs', path: 'm' } }),
    },
    {
      name: 'TTS',
      create: () => createTTS({ modelSource: { kind: 'fs', path: 'm' } }),
    },
    {
      name: 'Enhancement',
      create: () =>
        createEnhancement({ modelSource: { kind: 'fs', path: 'm' } }),
    },
    {
      name: 'Separation',
      create: () =>
        createSeparation({ modelSource: { kind: 'fs', path: 'm' } }),
    },
  ];

  const liveAudioOut2 = 'live_11111111-2222-3333-4444-555555555555';

  function liveOverloadArgs(name: string): {
    method: string;
    arg1: string;
    arg2: string | string[];
    policy: Record<string, unknown>;
  } {
    const liveAudio = 'live_12345678-1234-1234-1234-123456789012';
    const liveText = 'txt_live_87654321-4321-4321-4321-210987654321';
    const liveAudioOut = 'live_87654321-4321-4321-4321-210987654321';

    if (name === 'STT') {
      return {
        method: 'transcribe',
        arg1: liveAudio,
        arg2: liveText,
        policy: { evaluator: 'speech_energy_silence', maxSegmentMs: 1000 },
      };
    }
    if (name === 'Punctuation') {
      return {
        method: 'punctuate',
        arg1: liveText,
        arg2: liveText,
        policy: { evaluator: 'text_synthetic_auto' },
      };
    }
    if (name === 'TTS') {
      return {
        method: 'synthesize',
        arg1: liveText,
        arg2: liveAudio,
        policy: { evaluator: 'text_synthetic_auto' },
      };
    }
    if (name === 'Enhancement') {
      return {
        method: 'enhance',
        arg1: liveAudio,
        arg2: liveAudioOut,
        policy: { evaluator: 'continuous_frames' },
      };
    }
    return {
      method: 'separate',
      arg1: liveAudio,
      arg2: [liveAudioOut, liveAudioOut2],
      policy: { evaluator: 'continuous_frames' },
    };
  }

  it('X-1: Error code parity — should throw LIVE_OFFLINE_SEGMENTATION_REQUIRED for all features', async () => {
    for (const { name, create } of factories) {
      const engine: any = await create();
      const { method, arg1, arg2 } = liveOverloadArgs(name);

      await expect(engine[method](arg1, arg2, {})).rejects.toThrow(
        LiveOfflinePipelineError
      );

      try {
        await engine[method](arg1, arg2, {});
      } catch (e: any) {
        expect(e.code).toBe('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
      }
    }
  });

  it('X-2: Handle type parity — should return consistent handle shape for all features', async () => {
    for (const { name, create } of factories) {
      const engine: any = await create();
      const { method, arg1, arg2, policy } = liveOverloadArgs(name);

      const handle = await engine[method](arg1, arg2, {
        segmentation: { mode: 'auto', policy },
      });

      expect(handle).toHaveProperty('pipelineId');
      expect(handle).toHaveProperty('instanceId');
      expect(handle).toHaveProperty('completed');
      expect(handle).toHaveProperty('stop');
      expect(handle).toHaveProperty('flush');
      expect(handle).toHaveProperty('reset');
      expect(handle).toHaveProperty('getStatus');

      expect(typeof handle.pipelineId).toBe('string');
      expect(typeof handle.instanceId).toBe('string');
      expect(handle.completed).toBeInstanceOf(Promise);
    }
  });

  it('X-3: completed event parity — should resolve when native event fires', async () => {
    for (const { name, create } of factories) {
      const engine: any = await create();
      const { method, arg1, arg2, policy } = liveOverloadArgs(name);

      const handle = await engine[method](arg1, arg2, {
        segmentation: { mode: 'auto', policy },
      });

      const completionPromise = handle.completed;

      // Simulate native event
      emitter.emit('streamingPipelineCompleted', {
        pipelineId: handle.pipelineId,
        reason: 'completed',
        unitsRead: 100,
        unitsWritten: 100,
        processingTimeMs: 50,
      });

      const result = await completionPromise;
      expect(result.reason).toBe('completed');
      expect(result.unitsRead).toBe(100);
    }
  });

  it('X-4: Detach-on-stop parity — should invoke detachSegmentationEngine on handle.stop()', async () => {
    for (const { name, create } of factories) {
      const engine: any = await create();
      const { method, arg1, arg2, policy } = liveOverloadArgs(name);

      // Mock attachSegmentationEngine to return a fake engineId
      native.attachSegmentationEngine.mockResolvedValueOnce({
        engineId: `eng_${name}`,
      } as any);

      const handle = await engine[method](arg1, arg2, {
        segmentation: { mode: 'auto', policy },
      });

      await handle.stop();

      expect(native.stopStreamingPipeline).toHaveBeenCalledWith(
        handle.pipelineId
      );
      expect(native.detachSegmentationEngine).toHaveBeenCalledWith(
        `eng_${name}`,
        undefined
      );
    }
  });
});
