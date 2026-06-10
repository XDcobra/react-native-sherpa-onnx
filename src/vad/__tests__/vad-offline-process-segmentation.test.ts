const mockRunVadOffline = jest.fn();
const mockInitializeVad = jest.fn().mockResolvedValue(undefined);
const mockDetectVadModel = jest.fn().mockResolvedValue({
  success: true,
  modelType: 'silero_vad',
});
const mockUnloadVad = jest.fn().mockResolvedValue(undefined);

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeVad: (...args: unknown[]) => mockInitializeVad(...args),
    detectVadModel: (...args: unknown[]) => mockDetectVadModel(...args),
    runVadOffline: (...args: unknown[]) => mockRunVadOffline(...args),
    unloadVad: (...args: unknown[]) => mockUnloadVad(...args),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest.fn().mockResolvedValue('/tmp/vad-model'),
  resolveFileSourceForDetect: jest.fn().mockResolvedValue({
    modelDir: '/tmp/vad-model',
    assetName: null,
  }),
}));

const mockGetOfflineAudioBufferSamplesSlice = jest.fn();
const mockCreateOfflineAudioBufferFromSamples = jest.fn();
const mockReleasePipelineAudioBuffer = jest.fn().mockResolvedValue(undefined);

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'off_audio',
  getOfflineAudioBufferSamplesSlice: (...args: unknown[]) =>
    mockGetOfflineAudioBufferSamplesSlice(...args),
  createOfflineAudioBufferFromSamples: (...args: unknown[]) =>
    mockCreateOfflineAudioBufferFromSamples(...args),
  releasePipelineAudioBuffer: (...args: unknown[]) =>
    mockReleasePipelineAudioBuffer(...args),
}));

const mockSegmentOfflineBuffer = jest.fn();
const mockGetSegments = jest.fn();

jest.mock('../../segment', () => ({
  segmentOfflineBuffer: (...args: unknown[]) =>
    mockSegmentOfflineBuffer(...args),
  getSegments: (...args: unknown[]) => mockGetSegments(...args),
}));

const mockCreateEmptyOfflineSegmentBuffer = jest.fn();
const mockGetOfflineSegmentBufferSegments = jest.fn();
const mockAppendLiveSegment = jest.fn();
const mockCreateLiveSegmentBuffer = jest.fn();
const mockFinalizeLiveSegmentBuffer = jest.fn().mockResolvedValue(undefined);
const mockPopulateOfflineSegmentBufferIfEmpty = jest
  .fn()
  .mockResolvedValue(undefined);
const mockReleasePipelineSegmentBuffer = jest.fn().mockResolvedValue(undefined);

jest.mock('../../segmentbuffer', () => ({
  resolvePipelineSegmentBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'seg_off_output',
  createEmptyOfflineSegmentBuffer: (...args: unknown[]) =>
    mockCreateEmptyOfflineSegmentBuffer(...args),
  getOfflineSegmentBufferSegments: (...args: unknown[]) =>
    mockGetOfflineSegmentBufferSegments(...args),
  appendLiveSegment: (...args: unknown[]) => mockAppendLiveSegment(...args),
  createLiveSegmentBuffer: (...args: unknown[]) =>
    mockCreateLiveSegmentBuffer(...args),
  finalizeLiveSegmentBuffer: (...args: unknown[]) =>
    mockFinalizeLiveSegmentBuffer(...args),
  populateOfflineSegmentBufferIfEmpty: (...args: unknown[]) =>
    mockPopulateOfflineSegmentBufferIfEmpty(...args),
  releasePipelineSegmentBuffer: (...args: unknown[]) =>
    mockReleasePipelineSegmentBuffer(...args),
}));

import type { OrchestrationProgress } from '../types';
import type { SpeechSegment } from '../../segment/segment';

const { createStreamingVAD } = jest.requireActual(
  '../engine'
) as typeof import('../engine');

describe('VAD offline process: segmentation modes, native passes, and onProgress', () => {
  let nextSliceAudio = 0;
  let nextSliceSegment = 0;
  let nextAppendedIndex = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    nextSliceAudio = 0;
    nextSliceSegment = 0;
    nextAppendedIndex = 0;

    const speechSegments: SpeechSegment[] = [
      {
        segmentId: 'speech_0',
        domain: 'speech',
        startOffset: 100,
        endOffset: 500,
        reason: 'energy_silence',
        source: 'segmentation_engine',
        createdAtMs: 1,
        segmentIndex: 0,
        sourceAudioBufferId: 'off_audio',
        sampleRate: 16000,
        durationMs: 25,
      },
      {
        segmentId: 'speech_1',
        domain: 'speech',
        startOffset: 900,
        endOffset: 1500,
        reason: 'energy_silence',
        source: 'segmentation_engine',
        createdAtMs: 2,
        segmentIndex: 1,
        sourceAudioBufferId: 'off_audio',
        sampleRate: 16000,
        durationMs: 37.5,
      },
    ];

    mockSegmentOfflineBuffer.mockResolvedValue({
      segmentBufferId: 'seg_off_segments',
      domain: 'speech',
      parentBufferId: 'off_audio',
    });

    mockGetSegments.mockImplementation(
      async (_buffer: unknown, startIndex = 0): Promise<SpeechSegment[]> => {
        if (startIndex > 0) {
          return [];
        }
        return speechSegments;
      }
    );

    mockGetOfflineAudioBufferSamplesSlice.mockImplementation(
      (_audioId: unknown, _start: unknown, frameCount: unknown) =>
        new Float32Array(Math.max(0, Number(frameCount) || 0)).fill(0.125)
    );

    mockCreateOfflineAudioBufferFromSamples.mockImplementation(() => {
      const sliceIndex = nextSliceAudio;
      nextSliceAudio += 1;
      return {
        bufferId: `off_slice_${sliceIndex}`,
        info: {
          bufferId: `off_slice_${sliceIndex}`,
          kind: 'offlineAudioBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 1,
        },
      };
    });

    mockCreateEmptyOfflineSegmentBuffer.mockImplementation(async () => {
      const segmentIndex = nextSliceSegment;
      nextSliceSegment += 1;
      return {
        bufferId: `seg_tmp_${segmentIndex}`,
        info: {
          bufferId: `seg_tmp_${segmentIndex}`,
          kind: 'offlineSegmentBuffer',
          state: 'immutable',
          segmentCount: 0,
        },
      };
    });

    mockGetOfflineSegmentBufferSegments.mockImplementation(
      async (bufferId: unknown, start = 0) => {
        const id = String(bufferId);
        if (Number(start) > 0) {
          return [];
        }
        if (id === 'seg_tmp_0') {
          return [
            {
              id: 'slice_seg_0',
              kind: 'speech',
              sourceAudioBufferId: 'off_slice_0',
              startSample: 10,
              endSample: 120,
              sampleRate: 16000,
              durationMs: 6.875,
              payload: { source: 'vad', engine: 'vad', decision: 'model' },
            },
          ];
        }
        if (id === 'seg_tmp_1') {
          return [
            {
              id: 'slice_seg_1',
              kind: 'speech',
              sourceAudioBufferId: 'off_slice_1',
              startSample: 20,
              endSample: 160,
              sampleRate: 16000,
              durationMs: 8.75,
              payload: { source: 'vad', engine: 'vad', decision: 'model' },
            },
          ];
        }
        return [];
      }
    );

    mockCreateLiveSegmentBuffer.mockResolvedValue({
      bufferId: 'seg_live_staging',
      info: {
        bufferId: 'seg_live_staging',
        kind: 'liveSegmentBuffer',
        state: 'recording',
        segmentCount: 0,
        totalSegmentsWritten: 0,
        spool: {
          mode: 'on',
          enabled: true,
          ready: true,
          bytes: 0,
        },
      },
      unsubscribeEvents: jest.fn(),
    });

    mockAppendLiveSegment.mockImplementation(async () => {
      const segmentIndex = nextAppendedIndex;
      nextAppendedIndex += 1;
      return { segmentId: `seg_appended_${segmentIndex}`, segmentIndex };
    });

    mockRunVadOffline.mockImplementation(
      async (_instanceId: unknown, audioId: unknown) => {
        const id = String(audioId);
        if (id === 'off_slice_0') {
          return {
            chunksProcessed: 2,
            unitsRead: 400,
            unitsWritten: 1,
            segmentCount: 1,
            speechDurationMs: 7,
          };
        }
        if (id === 'off_slice_1') {
          return {
            chunksProcessed: 3,
            unitsRead: 600,
            unitsWritten: 1,
            segmentCount: 1,
            speechDurationMs: 9,
          };
        }
        return {
          chunksProcessed: 1,
          unitsRead: 3200,
          unitsWritten: 1,
          segmentCount: 1,
          speechDurationMs: 200,
        };
      }
    );
  });

  async function createEngine() {
    return createStreamingVAD({
      modelSource: { kind: 'fs', path: '/tmp/vad-model' },
      modelType: 'silero_vad',
      sampleRate: 16000,
    });
  }

  it('keeps single native pass when options are omitted', async () => {
    const engine = await createEngine();

    await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
    });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
    const call = mockRunVadOffline.mock.calls[0];
    expect(call?.[0]).toEqual(expect.stringMatching(/^vad_/));
    expect(call?.[1]).toBe('off_audio');
    expect(call?.[2]).toBe('seg_off_output');
    expect(call?.[3]).toEqual({});
  });

  it('passes only native-safe sourceTag for segmentation.mode=off', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();
    const abortController = new AbortController();

    await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        sourceTag: 'job-123',
        segmentation: { mode: 'off' },
        onProgress,
        abortSignal: abortController.signal,
      },
    });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
    const call = mockRunVadOffline.mock.calls[0];
    expect(call?.[3]).toEqual({ sourceTag: 'job-123' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('segmented mode runs per speech segment and merges into offline target', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();

    const out = await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        segmentation: { mode: 'auto' },
        onProgress,
      },
    });

    expect(mockSegmentOfflineBuffer).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline).toHaveBeenCalledTimes(2);
    expect(mockRunVadOffline.mock.calls[0]?.[1]).toBe('off_slice_0');
    expect(mockRunVadOffline.mock.calls[1]?.[1]).toBe('off_slice_1');
    expect(onProgress).toHaveBeenCalledTimes(2);

    const firstProgress = onProgress.mock.calls[0]?.[0] as
      | OrchestrationProgress
      | undefined;
    const secondProgress = onProgress.mock.calls[1]?.[0] as
      | OrchestrationProgress
      | undefined;

    expect(firstProgress).toMatchObject({
      currentSegment: 0,
      totalSegments: 2,
      fraction: 0,
      currentSegmentDurationMs: 25,
    });
    expect(secondProgress).toMatchObject({
      currentSegment: 1,
      totalSegments: 2,
      fraction: 0.5,
      currentSegmentDurationMs: 37.5,
    });
    expect((firstProgress?.elapsedMs ?? -1) >= 0).toBe(true);
    expect(
      (secondProgress?.elapsedMs ?? -1) >= (firstProgress?.elapsedMs ?? -1)
    ).toBe(true);

    const firstProgressOrder = onProgress.mock.invocationCallOrder[0] ?? 0;
    const secondProgressOrder = onProgress.mock.invocationCallOrder[1] ?? 0;
    const firstRunOrder = mockRunVadOffline.mock.invocationCallOrder[0] ?? 0;
    const secondRunOrder = mockRunVadOffline.mock.invocationCallOrder[1] ?? 0;
    expect(firstProgressOrder).toBeLessThan(firstRunOrder);
    expect(secondProgressOrder).toBeLessThan(secondRunOrder);

    expect(mockAppendLiveSegment).toHaveBeenCalledTimes(2);
    expect(mockAppendLiveSegment.mock.calls[0]?.[0]).toBe('seg_live_staging');
    expect(mockAppendLiveSegment.mock.calls[0]?.[1]).toMatchObject({
      sourceAudioBufferId: 'off_audio',
      startSample: 110,
      endSample: 220,
    });
    expect(mockAppendLiveSegment.mock.calls[1]?.[0]).toBe('seg_live_staging');
    expect(mockAppendLiveSegment.mock.calls[1]?.[1]).toMatchObject({
      sourceAudioBufferId: 'off_audio',
      startSample: 920,
      endSample: 1060,
    });

    expect(mockFinalizeLiveSegmentBuffer).toHaveBeenCalledWith(
      'seg_live_staging'
    );
    expect(mockPopulateOfflineSegmentBufferIfEmpty).toHaveBeenCalledWith(
      'seg_off_output',
      'seg_live_staging'
    );

    expect(out).toMatchObject({
      segmentBufferId: 'seg_off_output',
      summary: {
        chunksProcessed: 5,
        unitsRead: 1000,
        unitsWritten: 2,
        segmentCount: 2,
        speechDurationMs: 16,
      },
    });
  });

  it('segmented mode does not emit progress when onProgress is undefined', async () => {
    const engine = await createEngine();

    await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        segmentation: { mode: 'auto' },
      },
    });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(2);
  });

  it('segmented mode returns deterministic zero summary when no speech segments are found', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();
    mockGetSegments.mockResolvedValueOnce([]);

    const out = await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        segmentation: { mode: 'auto' },
        onProgress,
      },
    });

    expect(mockSegmentOfflineBuffer).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline).not.toHaveBeenCalled();
    expect(mockCreateOfflineAudioBufferFromSamples).not.toHaveBeenCalled();
    expect(mockAppendLiveSegment).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      segmentBufferId: 'seg_off_output',
      summary: {
        chunksProcessed: 0,
        unitsRead: 0,
        unitsWritten: 0,
        segmentCount: 0,
        speechDurationMs: 0,
      },
    });
  });

  it('segmented mode with one full-span speech segment emits one progress event and one native call', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();
    const fullSpanSegment: SpeechSegment = {
      segmentId: 'speech_full',
      domain: 'speech',
      startOffset: 0,
      endOffset: 3200,
      reason: 'energy_silence',
      source: 'segmentation_engine',
      createdAtMs: 10,
      segmentIndex: 0,
      sourceAudioBufferId: 'off_audio',
      sampleRate: 16000,
      durationMs: 200,
    };

    mockGetSegments.mockImplementation(
      async (_buffer: unknown, startIndex = 0): Promise<SpeechSegment[]> => {
        if (startIndex > 0) {
          return [];
        }
        return [fullSpanSegment];
      }
    );

    mockGetOfflineSegmentBufferSegments.mockImplementation(
      async (bufferId: unknown, start = 0) => {
        if (String(bufferId) !== 'seg_tmp_0' || Number(start) > 0) {
          return [];
        }
        return [
          {
            id: 'slice_seg_full',
            kind: 'speech',
            sourceAudioBufferId: 'off_slice_0',
            startSample: 0,
            endSample: 3200,
            sampleRate: 16000,
            durationMs: 200,
            payload: { source: 'vad', engine: 'vad', decision: 'model' },
          },
        ];
      }
    );

    mockRunVadOffline.mockResolvedValueOnce({
      chunksProcessed: 4,
      unitsRead: 3200,
      unitsWritten: 1,
      segmentCount: 1,
      speechDurationMs: 200,
    });

    const out = await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        segmentation: { mode: 'auto' },
        onProgress,
      },
    });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline.mock.calls[0]?.[1]).toBe('off_slice_0');
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      currentSegment: 0,
      totalSegments: 1,
      fraction: 0,
      currentSegmentDurationMs: 200,
    });
    expect(mockAppendLiveSegment).toHaveBeenCalledWith(
      'seg_live_staging',
      expect.objectContaining({
        sourceAudioBufferId: 'off_audio',
        startSample: 0,
        endSample: 3200,
      })
    );
    expect(out).toMatchObject({
      segmentBufferId: 'seg_off_output',
      summary: {
        chunksProcessed: 4,
        unitsRead: 3200,
        unitsWritten: 1,
        segmentCount: 1,
        speechDurationMs: 200,
      },
    });
  });

  it('segmented mode is fail-fast without retry when a segment call fails', async () => {
    const engine = await createEngine();
    const failure = Object.assign(
      new Error('VAD_INTERNAL_ERROR: first segment failure'),
      {
        code: 'VAD_INTERNAL_ERROR',
      }
    );

    mockRunVadOffline.mockRejectedValueOnce(failure);

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: { mode: 'auto' },
        },
      })
    ).rejects.toMatchObject({ code: 'VAD_INTERNAL_ERROR' });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline.mock.calls[0]?.[1]).toBe('off_slice_0');
  });

  it('propagates onProgress callback errors and does not run native VAD for that segment', async () => {
    const engine = await createEngine();
    const callbackFailure = new Error('VAD_PROGRESS_CALLBACK_FAILED');
    const onProgress = jest.fn(() => {
      throw callbackFailure;
    });

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: { mode: 'auto' },
          onProgress,
        },
      })
    ).rejects.toThrow('VAD_PROGRESS_CALLBACK_FAILED');

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline).not.toHaveBeenCalled();
  });

  it('emits progress before each segment run even when a later segment fails', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();
    const failure = Object.assign(
      new Error('VAD_INTERNAL_ERROR: segment failure'),
      {
        code: 'VAD_INTERNAL_ERROR',
      }
    );

    mockRunVadOffline
      .mockResolvedValueOnce({
        chunksProcessed: 2,
        unitsRead: 400,
        unitsWritten: 1,
        segmentCount: 1,
        speechDurationMs: 7,
      })
      .mockRejectedValueOnce(failure);

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: { mode: 'auto' },
          onProgress,
        },
      })
    ).rejects.toMatchObject({ code: 'VAD_INTERNAL_ERROR' });

    expect(mockRunVadOffline).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(2);

    const firstProgress = onProgress.mock.calls[0]?.[0] as
      | OrchestrationProgress
      | undefined;
    const secondProgress = onProgress.mock.calls[1]?.[0] as
      | OrchestrationProgress
      | undefined;
    expect(firstProgress?.currentSegment).toBe(0);
    expect(secondProgress?.currentSegment).toBe(1);

    const secondProgressOrder = onProgress.mock.invocationCallOrder[1] ?? 0;
    const secondRunOrder = mockRunVadOffline.mock.invocationCallOrder[1] ?? 0;
    expect(secondProgressOrder).toBeLessThan(secondRunOrder);
  });

  it('emits progress for each planned segment even when one segment is skipped', async () => {
    const engine = await createEngine();
    const onProgress = jest.fn();
    const segmentsWithZeroFrame: SpeechSegment[] = [
      {
        segmentId: 'speech_zero_frame',
        domain: 'speech',
        startOffset: 400,
        endOffset: 400,
        reason: 'energy_silence',
        source: 'segmentation_engine',
        createdAtMs: 1,
        segmentIndex: 0,
        sourceAudioBufferId: 'off_audio',
        sampleRate: 16000,
        durationMs: 0,
      },
      {
        segmentId: 'speech_real',
        domain: 'speech',
        startOffset: 1000,
        endOffset: 1800,
        reason: 'energy_silence',
        source: 'segmentation_engine',
        createdAtMs: 2,
        segmentIndex: 1,
        sourceAudioBufferId: 'off_audio',
        sampleRate: 16000,
        durationMs: 50,
      },
    ];

    mockGetSegments.mockImplementation(
      async (_buffer: unknown, startIndex = 0): Promise<SpeechSegment[]> => {
        if (startIndex > 0) {
          return [];
        }
        return segmentsWithZeroFrame;
      }
    );

    await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_off_output',
      options: {
        segmentation: { mode: 'auto' },
        onProgress,
      },
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      currentSegment: 0,
      totalSegments: 2,
      fraction: 0,
    });
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({
      currentSegment: 1,
      totalSegments: 2,
      fraction: 0.5,
    });
    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
    expect(mockRunVadOffline.mock.calls[0]?.[1]).toBe('off_slice_0');
  });

  it('checks abort before emitting progress for the next segment', async () => {
    const engine = await createEngine();
    const abortController = new AbortController();
    const onProgress = jest.fn((progress: OrchestrationProgress) => {
      if (progress.currentSegment === 0) {
        abortController.abort();
      }
    });

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: { mode: 'auto' },
          onProgress,
          abortSignal: abortController.signal,
        },
      })
    ).rejects.toMatchObject({ code: 'VAD_ABORTED' });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({
      currentSegment: 0,
      totalSegments: 2,
    });
    expect(mockRunVadOffline).toHaveBeenCalledTimes(1);
  });

  it('segmented mode writes directly into live target without offline staging', async () => {
    const engine = await createEngine();

    await engine.process({
      audioIn: 'off_audio',
      segmentOut: 'seg_live_output',
      options: {
        segmentation: { mode: 'auto' },
      },
    });

    expect(mockCreateLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(mockFinalizeLiveSegmentBuffer).not.toHaveBeenCalled();
    expect(mockPopulateOfflineSegmentBufferIfEmpty).not.toHaveBeenCalled();
    expect(mockAppendLiveSegment).toHaveBeenCalledTimes(2);
    expect(mockAppendLiveSegment.mock.calls[0]?.[0]).toBe('seg_live_output');
    expect(mockAppendLiveSegment.mock.calls[1]?.[0]).toBe('seg_live_output');
  });

  it('rejects non-function onProgress', async () => {
    const engine = await createEngine();

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          onProgress: 123 as unknown as (
            progress: OrchestrationProgress
          ) => void,
        },
      })
    ).rejects.toMatchObject({ code: 'VAD_INVALID_OPTIONS' });

    expect(mockRunVadOffline).not.toHaveBeenCalled();
  });

  it('keeps segmentation policy validation for mode=off', async () => {
    const engine = await createEngine();

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: {
            mode: 'off',
            policy: {
              evaluator: 'speech_energy_silence',
            } as unknown as {
              evaluator: 'speech_energy_silence';
            },
          },
        },
      })
    ).rejects.toThrow(
      "SEGMENTATION_POLICY_INVALID: offline VAD ignores segmentation.policy when segmentation.mode='off'; use mode='auto'"
    );

    expect(mockRunVadOffline).not.toHaveBeenCalled();
  });
});
