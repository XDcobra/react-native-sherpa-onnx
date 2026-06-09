jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeTts: jest.fn(),
    synthesizeTts: jest.fn(),
    unloadTts: jest.fn(),
    getTtsSampleRate: jest.fn(),
    getTtsNumSpeakers: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveBundledAssetPath: jest.fn(async () => '/models/tts'),
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/tts'),
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/tts',
    assetName: 'model.onnx',
  })),
}));

jest.mock('../../model-languages', () => ({
  publicLanguageHintsFromNative: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    'bufferId' in value &&
    typeof (value as { bufferId: unknown }).bufferId === 'string'
      ? (value as { bufferId: string }).bufferId
      : String(value)
  ),
  releasePipelineAudioBuffer: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    'bufferId' in value &&
    typeof (value as { bufferId: unknown }).bufferId === 'string'
      ? (value as { bufferId: string }).bufferId
      : String(value)
  ),
}));

jest.mock('../orchestrate', () => ({
  runOfflineTtsPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createTTS } from '../index';
import { runOfflineTtsPipeline } from '../orchestrate';
import type { OfflineAudioBufferRef } from '../../audiobuffer/types';
import type { OfflineTextBufferRef } from '../../textbuffer/types';

describe('tts synthesize mode 1 (one-shot)', () => {
  const textIn = {
    bufferId: 'txt_off_in' as OfflineTextBufferRef['bufferId'],
  } as OfflineTextBufferRef;
  const audioOut = {
    bufferId: 'off_out' as OfflineAudioBufferRef['bufferId'],
  } as OfflineAudioBufferRef;

  const native = SherpaOnnx as unknown as {
    initializeTts: jest.Mock;
    synthesizeTts: jest.Mock;
    unloadTts: jest.Mock;
    getTtsSampleRate: jest.Mock;
    getTtsNumSpeakers: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeTts.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'vits', modelDir: '/models/tts' }],
    });
    native.synthesizeTts.mockResolvedValue(undefined);
    native.unloadTts.mockResolvedValue(undefined);
    native.getTtsSampleRate.mockResolvedValue(22050);
    native.getTtsNumSpeakers.mockResolvedValue(1);
  });

  it('uses direct native synth path by default and returns complete result', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const result = await tts.synthesize(textIn, audioOut);

    expect(native.synthesizeTts).toHaveBeenCalledWith(
      expect.stringMatching(/^tts_/),
      'txt_off_in',
      'off_out',
      undefined
    );
    expect(runOfflineTtsPipeline).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'complete',
      totalSegments: 1,
      completedSegments: 1,
      skippedSegments: [],
    });
  });

  it('keeps one-shot path when segmentation mode is explicitly off', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const result = await tts.synthesize(textIn, audioOut, {
      segmentation: { mode: 'off' },
      sid: 3,
    });

    expect(native.synthesizeTts).toHaveBeenCalledTimes(1);
    expect(runOfflineTtsPipeline).not.toHaveBeenCalled();
    expect(result.status).toBe('complete');
  });

  it('rejects segmentation.policy when mode is off', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    await expect(
      tts.synthesize(textIn, audioOut, {
        segmentation: {
          mode: 'off',
          policy: { evaluator: 'text_synthetic_auto' },
        },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(native.synthesizeTts).not.toHaveBeenCalled();
    expect(runOfflineTtsPipeline).not.toHaveBeenCalled();
  });

  it('rejects manual segmentation mode in offline synth API', async () => {
    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    await expect(
      tts.synthesize(textIn, audioOut, {
        segmentation: { mode: 'manual' },
      })
    ).rejects.toThrow('SEGMENTATION_POLICY_INVALID');

    expect(native.synthesizeTts).not.toHaveBeenCalled();
    expect(runOfflineTtsPipeline).not.toHaveBeenCalled();
  });
});
