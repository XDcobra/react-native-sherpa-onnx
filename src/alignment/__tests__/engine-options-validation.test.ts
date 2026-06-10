jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn().mockResolvedValue({
      success: true,
      paths: { model: '/tmp/alignment-model/model.onnx' },
    }),
    alignOfflineTextToAudio: jest.fn().mockResolvedValue({
      outputSegmentBufferId: 'seg_out',
      segmentsWritten: 1,
    }),
  },
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'off_audio',
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'txt_off',
}));

jest.mock('../../segmentbuffer', () => ({
  getOfflineSegmentBufferSegments: jest.fn().mockResolvedValue([
    {
      segmentId: 'seg_anchor_0',
      kind: 'speech',
      startSample: 0,
      endSample: 3200,
      sampleRate: 16000,
      startMs: 0,
      endMs: 200,
    },
  ]),
  resolveOfflineSegmentBufferId: (source: unknown) =>
    typeof source === 'string'
      ? source
      : (source as { bufferId?: string })?.bufferId ?? 'seg_off',
}));

jest.mock('../../utils', () => ({
  resolveBundledAssetPath: jest.fn().mockResolvedValue('/tmp/alignment-model'),
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest
    .fn()
    .mockResolvedValue('/tmp/alignment-model'),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createAlignment } from '../engine';

describe('AlignmentEngine options validation', () => {
  const native = SherpaOnnx as unknown as {
    alignOfflineTextToAudio: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits ALIGNMENT_OPTIONS_INVALID for unknown mode', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'unknown',
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_OPTIONS_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_MODEL_PATH_INVALID for non-ModelPath accurate input', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        modelSource: '/tmp/model',
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_MODEL_PATH_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_MODEL_PATH_INVALID for custom mode with invalid customConfig', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        initMode: 'custom',
        modelType: 'wav2vec2',
        customConfig: { model: '/tmp/model.onnx' },
        segmentation: { mode: 'off' },
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_MODEL_PATH_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_MODEL_PATH_INVALID for custom mode with wrong modelType', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        initMode: 'custom',
        modelType: 'other',
        customConfig: { model: { kind: 'fs', path: '/tmp/model.onnx' } },
        segmentation: { mode: 'off' },
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_MODEL_PATH_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_GRANULARITY_INVALID for disallowed granularity', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'proportional',
        granularity: 'character',
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_GRANULARITY_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_OPTIONS_INVALID for non-function onProgress', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'proportional',
        onProgress: 123 as any,
      } as any)
    ).rejects.toMatchObject({ code: 'ALIGNMENT_OPTIONS_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_ASR_HYPOTHESIS_MISSING when asrMediated omits hypothesis buffer', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        modelSource: { kind: 'fs', path: '/tmp/model' },
        granularity: 'word',
        segmentation: {
          mode: 'auto',
          anchorSegmentBuffer: 'seg_anchor',
          mappingStrategy: 'asr_mediated',
        } as any,
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_ASR_HYPOTHESIS_MISSING' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_OPTIONS_INVALID when chunkedForcedCtc incorrectly passes asr config', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        modelSource: { kind: 'fs', path: '/tmp/model' },
        granularity: 'word',
        segmentation: {
          mode: 'auto',
          anchorSegmentBuffer: 'seg_anchor',
          mappingStrategy: 'chunked_forced_ctc',
          asr: { hypothesisTextBuffer: 'txt_hyp' },
        } as any,
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_OPTIONS_INVALID' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('emits ALIGNMENT_ENGINE_DESTROYED after destroy()', async () => {
    const engine = createAlignment();
    await engine.destroy();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'proportional',
        granularity: 'word',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_ENGINE_DESTROYED' });
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });

  it('passes through ALIGNMENT_NOT_IMPLEMENTED from native bridge', async () => {
    const engine = createAlignment();
    native.alignOfflineTextToAudio.mockRejectedValueOnce(
      Object.assign(
        new Error('ALIGNMENT_NOT_IMPLEMENTED: row not implemented natively'),
        {
          code: 'ALIGNMENT_NOT_IMPLEMENTED',
        }
      )
    );

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        modelSource: { kind: 'fs', path: '/tmp/model' },
        granularity: 'word',
        segmentation: { mode: 'off' },
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_NOT_IMPLEMENTED' });
  });

  it('rejects segmentation.mode=manual with SEGMENTATION_POLICY_INVALID', async () => {
    const engine = createAlignment();

    await expect(
      engine.alignTextToAudio('txt_off', 'off_audio', 'seg_off', {
        mode: 'accurate',
        modelSource: { kind: 'fs', path: '/tmp/model' },
        granularity: 'word',
        segmentation: {
          mode: 'manual',
        } as any,
      })
    ).rejects.toThrow(
      'SEGMENTATION_POLICY_INVALID: alignment does not support segmentation.mode=manual'
    );
    expect(native.alignOfflineTextToAudio).not.toHaveBeenCalled();
  });
});
