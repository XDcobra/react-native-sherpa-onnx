type ProgressListener = (event: Record<string, unknown>) => void;

const mockListeners: ProgressListener[] = [];
const mockRemove = jest.fn();

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: (eventName: string, handler: ProgressListener) => {
      if (eventName === 'diarizationProgress') mockListeners.push(handler);
      return { remove: mockRemove };
    },
  })),
  NativeModules: { SherpaOnnx: {} },
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeDiarization: jest.fn(),
    diarizeOffline: jest.fn(),
    cancelDiarization: jest.fn(),
    unloadDiarization: jest.fn(),
  },
}));

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models',
    assetName: null,
  })),
  resolveFileSourceForModelInit: jest.fn(
    async (src: { path?: string }) => src.path ?? '/models/m.onnx'
  ),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(async () => ({
    kind: 'offlinePcmBuffer',
    bufferId: 'off_audio',
    sampleRate: 16000,
  })),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../segmentbuffer', () => ({
  getPipelineSegmentBufferInfo: jest.fn(async () => ({
    kind: 'offlineSegmentBuffer',
    bufferId: 'seg_off_out',
    segmentCount: 0,
  })),
  resolveOfflineSegmentBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createDiarization } from '../index';

const native = SherpaOnnx as unknown as {
  initializeDiarization: jest.Mock;
  diarizeOffline: jest.Mock;
};

async function createEngine() {
  native.initializeDiarization.mockResolvedValue({
    success: true,
    sampleRate: 16000,
  });
  return createDiarization({
    segmentation: { modelSource: { kind: 'fs', path: '/models/seg.onnx' } },
    embedding: { modelSource: { kind: 'fs', path: '/models/emb.onnx' } },
  });
}

describe('diarize progress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListeners.length = 0;
  });

  it('forwards native progress of its own run and ends with fraction 1', async () => {
    const engine = await createEngine();
    native.diarizeOffline.mockImplementation(
      async (
        _id: string,
        _a: string,
        _s: string,
        _o: boolean,
        operationId: string
      ) => {
        const emit = (event: Record<string, unknown>) =>
          mockListeners.forEach((l) => l(event));
        emit({ operationId: 'other', fraction: 0.9, phase: 'embedding' });
        emit({
          operationId,
          fraction: 0.2,
          phase: 'segmentation',
          current: 4,
          total: 9,
        });
        emit({
          operationId,
          fraction: 0.1,
          phase: 'segmentation',
          current: 5,
          total: 9,
        });
        emit({
          operationId,
          fraction: 0.6,
          phase: 'embedding',
          current: 3,
          total: 10,
        });
        return {
          success: true,
          segmentCount: 3,
          numSpeakers: 2,
          sampleRate: 16000,
        };
      }
    );
    const onProgress = jest.fn();

    await engine.diarize('off_audio', 'seg_off_out', { onProgress });

    const operationId = native.diarizeOffline.mock.calls[0]?.[4];
    expect(typeof operationId).toBe('string');
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        phase: 'segmentation',
        currentSegment: 4,
        totalSegments: 9,
        fraction: 0.2,
      }),
      // Fraction never goes back.
      expect.objectContaining({ currentSegment: 5, fraction: 0.2 }),
      expect.objectContaining({ phase: 'embedding', fraction: 0.6 }),
      expect.objectContaining({ fraction: 1, totalSegments: 3 }),
    ]);
    expect(mockRemove).toHaveBeenCalled();
  });

  it('passes no operation id without onProgress', async () => {
    const engine = await createEngine();
    native.diarizeOffline.mockResolvedValue({
      success: true,
      segmentCount: 0,
      numSpeakers: 0,
      sampleRate: 16000,
    });

    await engine.diarize('off_audio', 'seg_off_out');

    expect(native.diarizeOffline.mock.calls[0]).toHaveLength(4);
    expect(mockListeners).toHaveLength(0);
  });
});
