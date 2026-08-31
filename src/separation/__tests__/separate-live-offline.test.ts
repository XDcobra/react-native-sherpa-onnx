import { createSeparation } from '../index';
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

jest.mock('../../audiobuffer/streamingPipelineCompletion', () => ({
  createStreamingPipelineCompletionPromise: jest.fn(() =>
    Promise.resolve({ pipelineId: 'pipe_1', reason: 'completed' })
  ),
}));

jest.mock('../../NativeSherpaOnnx', () => {
  return {
    __esModule: true,
    default: {
      initializeSeparation: jest.fn(),
      unloadSeparation: jest.fn(),
      getSeparationNumStems: jest.fn(),
      startSeparationOfflineLivePipeline: jest.fn(),
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

describe('Separation Engine - Live Offline Overload', () => {
  let separator: Awaited<ReturnType<typeof createSeparation>>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttachSegmentationEngine.mockResolvedValue({ engineId: 'seg_1' });
    mockGetSegmentationEngineInfo.mockResolvedValue({
      engineId: 'seg_1',
      segmentBufferId: 'seg_live_1',
    });
    mockDetachSegmentationEngine.mockResolvedValue(undefined);
    (SherpaOnnx.initializeSeparation as jest.Mock).mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'auto', modelDir: 'test_model' }],
      numStems: 2,
      sampleRate: 44100,
    });
    (SherpaOnnx.getSeparationNumStems as jest.Mock).mockResolvedValue(2);
    separator = await createSeparation({
      modelSource: { kind: 'fs', path: 'test_model' },
    });
  });

  afterEach(async () => {
    await separator.destroy();
  });

  const dummyLiveIn: LiveAudioBufferIdSource =
    'live_12345678-1234-1234-1234-123456789012';
  const dummyLiveOuts: LiveAudioBufferIdSource[] = [
    'live_87654321-4321-4321-4321-210987654321',
    'live_11111111-2222-3333-4444-555555555555',
  ];

  it('SL-1: resolves a pipeline handle with continuous_frames policy and N outputs', async () => {
    (
      SherpaOnnx.startSeparationOfflineLivePipeline as jest.Mock
    ).mockResolvedValue({
      pipelineId: 'live_offline_sep_123',
    });

    const result = await separator.separate(dummyLiveIn, dummyLiveOuts, {
      segmentation: {
        mode: 'auto',
        policy: {
          evaluator: 'continuous_frames',
          checkpointIntervalMs: 500,
        },
      },
    });

    expect(result).toHaveProperty('pipelineId', 'live_offline_sep_123');
    expect(mockAttachSegmentationEngine).toHaveBeenCalledWith(dummyLiveIn, {
      policy: {
        evaluator: 'continuous_frames',
        checkpointIntervalMs: 500,
      },
    });
    expect(SherpaOnnx.startSeparationOfflineLivePipeline).toHaveBeenCalledWith(
      expect.any(String),
      'live_12345678-1234-1234-1234-123456789012',
      [
        'live_87654321-4321-4321-4321-210987654321',
        'live_11111111-2222-3333-4444-555555555555',
      ],
      {
        attachedSegmentationEngineId: 'seg_1',
        segmentLiveBufferId: 'seg_live_1',
      }
    );
  });

  it('SL-2: throws LIVE_OFFLINE_SEGMENTATION_REQUIRED if no policy is provided', async () => {
    await expect(
      separator.separate(dummyLiveIn, dummyLiveOuts, {
        segmentation: { mode: 'auto' } as any,
      })
    ).rejects.toThrow('LIVE_OFFLINE_SEGMENTATION_REQUIRED');
  });

  it('SL-3: rejects non-continuous_frames evaluator', async () => {
    await expect(
      separator.separate(dummyLiveIn, dummyLiveOuts, {
        segmentation: {
          mode: 'auto',
          policy: {
            evaluator: 'speech_energy_silence',
            maxSegmentMs: 2000,
          },
        },
      } as any)
    ).rejects.toThrow('supports only continuous_frames policy');
  });

  it('SL-4a: rejects mixed live/offline outputs', async () => {
    await expect(
      separator.separate(
        dummyLiveIn,
        [
          'live_87654321-4321-4321-4321-210987654321',
          'off_11111111-2222-3333-4444-555555555555',
        ],
        {
          segmentation: {
            mode: 'auto',
            policy: { evaluator: 'continuous_frames' },
          },
        }
      )
    ).rejects.toThrow(
      'SEPARATION_INVALID_ARGUMENT: separate() overload mismatch'
    );
  });

  it('SL-4: throws SEPARATION_INVALID_ARGUMENT on mixed buffer kinds', async () => {
    await expect(
      separator.separate(
        dummyLiveIn,
        [
          'live_87654321-4321-4321-4321-210987654321',
          'off_11111111-2222-3333-4444-555555555555',
        ],
        {
          segmentation: {
            mode: 'auto',
            policy: { evaluator: 'continuous_frames' },
          },
        }
      )
    ).rejects.toThrow(
      'SEPARATION_INVALID_ARGUMENT: separate() overload mismatch'
    );

    await expect(
      separator.separate(
        'off_12345678-1234-1234-1234-123456789012',
        dummyLiveOuts,
        {
          segmentation: {
            mode: 'auto',
            policy: { evaluator: 'continuous_frames' },
          },
        }
      )
    ).rejects.toThrow(
      'SEPARATION_INVALID_ARGUMENT: separate() overload mismatch'
    );
  });

  it('SL-5: throws when stem count mismatches getNumStems()', async () => {
    await expect(
      separator.separate(dummyLiveIn, [dummyLiveOuts[0]!], {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'continuous_frames' },
        },
      })
    ).rejects.toThrow(
      'SEPARATION_INVALID_ARGUMENT: separate() expects 2 output buffers'
    );
  });

  it('SL-6: handle.stop() invokes stopStreamingPipeline', async () => {
    (
      SherpaOnnx.startSeparationOfflineLivePipeline as jest.Mock
    ).mockResolvedValue({
      pipelineId: 'live_offline_sep_456',
    });

    const handle = await separator.separate(dummyLiveIn, dummyLiveOuts, {
      segmentation: {
        mode: 'auto',
        policy: { evaluator: 'continuous_frames' },
      },
    });

    await handle.stop();
    expect(SherpaOnnx.stopStreamingPipeline).toHaveBeenCalledWith(
      'live_offline_sep_456'
    );
  });
});
