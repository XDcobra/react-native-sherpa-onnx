jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeVad: jest.fn().mockResolvedValue(undefined),
    detectVadModel: jest.fn().mockResolvedValue({
      success: true,
      modelType: 'silero_vad',
    }),
    runVadOffline: jest.fn().mockResolvedValue({
      chunksProcessed: 1,
      unitsRead: 3200,
      unitsWritten: 1,
      segmentCount: 1,
      speechDurationMs: 200,
    }),
    unloadVad: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest.fn().mockResolvedValue('/tmp/vad-model'),
  resolveFileSourceForDetect: jest.fn().mockResolvedValue({
    modelDir: '/tmp/vad-model',
    assetName: null,
  }),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'off_audio',
}));

jest.mock('../../segmentbuffer', () => ({
  resolvePipelineSegmentBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'seg_off_output',
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import type { OrchestrationProgress } from '../types';

const { createStreamingVAD } = jest.requireActual(
  '../engine'
) as typeof import('../engine');

type NativeVadBridgeMock = {
  runVadOffline: jest.Mock;
};

describe('VAD offline phase-0 option contract', () => {
  const native = SherpaOnnx as unknown as NativeVadBridgeMock;

  beforeEach(() => {
    jest.clearAllMocks();
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

    expect(native.runVadOffline).toHaveBeenCalledTimes(1);
    const call = native.runVadOffline.mock.calls[0];
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

    expect(native.runVadOffline).toHaveBeenCalledTimes(1);
    const call = native.runVadOffline.mock.calls[0];
    expect(call?.[3]).toEqual({ sourceTag: 'job-123' });
  });

  it('rejects segmentation.mode=auto in phase 0', async () => {
    const engine = await createEngine();

    await expect(
      engine.process({
        audioIn: 'off_audio',
        segmentOut: 'seg_off_output',
        options: {
          segmentation: { mode: 'auto' },
        },
      })
    ).rejects.toMatchObject({ code: 'VAD_NOT_IMPLEMENTED' });

    expect(native.runVadOffline).not.toHaveBeenCalled();
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

    expect(native.runVadOffline).not.toHaveBeenCalled();
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

    expect(native.runVadOffline).not.toHaveBeenCalled();
  });
});
