import { createEnhancement } from '../index';
import type { LiveAudioBufferIdSource } from '../../audiobuffer/types';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/test/path',
  exists: jest.fn(),
  readDir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn(() => ({
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
}));

jest.mock('../../NativeSherpaOnnx', () => {
  return {
    __esModule: true,
    default: {
      detectEnhancementModel: jest.fn(),
      initializeEnhancement: jest.fn(),
      unloadEnhancement: jest.fn(),
      startEnhancementOfflineLivePipeline: jest.fn(),
      stopStreamingPipeline: jest.fn(),
      flushStreamingPipeline: jest.fn(),
      resetStreamingPipeline: jest.fn(),
      getStreamingPipelineStatus: jest.fn(),
    },
  };
});

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

import SherpaOnnx from '../../NativeSherpaOnnx';

describe('Enhancement Engine - Live Offline Overload', () => {
  let enhancer: Awaited<ReturnType<typeof createEnhancement>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      engineId: 'seg_1',
      segmentBufferId: 'seg_live_1',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);
    (SherpaOnnx.detectEnhancementModel as jest.Mock).mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'test_model' }],
    });
    (SherpaOnnx.initializeEnhancement as jest.Mock).mockResolvedValue({
      success: true,
      sampleRate: 16000,
    });
    enhancer = await createEnhancement({
      modelSource: { kind: 'fs', path: 'test_model' },
    });
  });

  afterEach(async () => {
    await enhancer.destroy();
  });

  const dummyLiveIn: LiveAudioBufferIdSource =
    'live_12345678-1234-1234-1234-123456789012';
  const dummyLiveOut: LiveAudioBufferIdSource =
    'live_87654321-4321-4321-4321-210987654321';

  it('LE-1: should resolve a pipeline handle when called with live buffers and continuous_frames policy', async () => {
    (
      SherpaOnnx.startEnhancementOfflineLivePipeline as jest.Mock
    ).mockResolvedValue({
      pipelineId: 'live_offline_enh_123',
    });

    const result = await enhancer.enhance(dummyLiveIn, dummyLiveOut, {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'continuous_frames',
          checkpointIntervalMs: 500,
        },
      },
    });

    expect(result).toHaveProperty('pipelineId', 'live_offline_enh_123');
    expect(mockAttachSegmentationEngine).toHaveBeenCalledWith(dummyLiveIn, {
      policy: {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 500,
      },
    });
    expect(mockGetSegmentationEngineInfo).toHaveBeenCalledWith('seg_1');
    expect(SherpaOnnx.startEnhancementOfflineLivePipeline).toHaveBeenCalledWith(
      expect.any(String),
      'live_12345678-1234-1234-1234-123456789012',
      'live_87654321-4321-4321-4321-210987654321',
      {
        attachedSegmentationEngineId: 'seg_1',
        segmentLiveBufferId: 'seg_live_1',
      }
    );
  });

  it('LE-2: should throw LIVE_OFFLINE_SEGMENTATION_REQUIRED if no policy is provided', async () => {
    await expect(
      enhancer.enhance(dummyLiveIn, dummyLiveOut, {
        segmentation: { mode: 'auto' } as any,
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('LE-3: should throw LIVE_OFFLINE_SEGMENTATION_REQUIRED if evaluator is not continuous_frames', async () => {
    await expect(
      enhancer.enhance(dummyLiveIn, dummyLiveOut, {
        segmentation: {
          mode: 'auto',
          policy: {
            evaluator: 'speech_energy_silence',
            maxSegmentMs: 2000,
          },
        },
      })
    ).rejects.toThrow('supports only continuous_frames policy');
  });

  it('LE-4: should throw ENHANCE_INVALID_ARGUMENT if there is a mixed buffer match', async () => {
    await expect(
      enhancer.enhance(
        'live_12345678-1234-1234-1234-123456789012',
        'off_87654321-4321-4321-4321-210987654321'
      )
    ).rejects.toThrow('ENHANCE_INVALID_ARGUMENT: enhance() overload mismatch.');
    await expect(
      enhancer.enhance(
        'off_12345678-1234-1234-1234-123456789012',
        'live_87654321-4321-4321-4321-210987654321'
      )
    ).rejects.toThrow('ENHANCE_INVALID_ARGUMENT: enhance() overload mismatch.');
  });

  it('LE-8: handle.stop() should invoke SherpaOnnx.stopStreamingPipeline', async () => {
    (
      SherpaOnnx.startEnhancementOfflineLivePipeline as jest.Mock
    ).mockResolvedValue({
      pipelineId: 'live_offline_enh_456',
    });

    const handle = (await enhancer.enhance(dummyLiveIn, dummyLiveOut, {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'continuous_frames' },
      },
    })) as unknown as import('../../enhancement/streamingTypes').EnhancementPipelineHandle;

    await handle.stop();
    expect(SherpaOnnx.stopStreamingPipeline).toHaveBeenCalledWith(
      'live_offline_enh_456'
    );
  });
});
