jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeLanguageId: jest.fn(),
    identifyLanguageOffline: jest.fn(),
    unloadLanguageId: jest.fn(),
    detectLanguageIdModel: jest.fn(),
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

jest.mock('../../segment', () => ({
  segmentOfflineBuffer: jest.fn(),
}));

jest.mock('../../segmentbuffer', () => {
  const actual = jest.requireActual('../../segmentbuffer');
  return {
    ...actual,
    getOfflineSegmentBufferSegments: jest.fn(),
    createLiveSegmentBuffer: jest.fn(),
    appendLiveSegment: jest.fn(),
    finalizeLiveSegmentBuffer: jest.fn(),
    populateOfflineSegmentBufferIfEmpty: jest.fn(),
    releasePipelineSegmentBuffer: jest.fn(),
  };
});

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

import SherpaOnnx from '../../NativeSherpaOnnx';
import { segmentOfflineBuffer } from '../../segment';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
} from '../../segmentbuffer';
import type { SegmentMeta } from '../../segmentbuffer/types';
import {
  createLanguageIdentification,
  DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY,
} from '../index';

describe('createLanguageIdentification - segmented mode & labeling', () => {
  const audioId = 'off_11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
    (SherpaOnnx.initializeLanguageId as jest.Mock).mockResolvedValue({
      success: true,
    });
  });

  it('runs segmented offline language identification with code-switching analysis', async () => {
    const engine = await createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/models/encoder.onnx' },
        decoder: { kind: 'fs', path: '/models/decoder.onnx' },
      },
    });

    const mockSpans: SegmentMeta[] = [
      {
        id: 's1',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 0,
        endSample: 32000,
        sampleRate: 16000,
        durationMs: 2000,
      },
      {
        id: 's2',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 32000,
        endSample: 64000,
        sampleRate: 16000,
        durationMs: 2000,
      },
      {
        id: 's3',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 80000,
        endSample: 144000,
        sampleRate: 16000,
        durationMs: 4000,
      },
    ];

    (segmentOfflineBuffer as jest.Mock).mockResolvedValue({
      segmentBufferId: 'seg_off_11111111-1111-1111-1111-111111111111',
    });
    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue(mockSpans);

    (SherpaOnnx.identifyLanguageOffline as jest.Mock)
      .mockResolvedValueOnce({
        lang: 'en',
        audioDuration: 2.0,
        elapsedMs: 50,
      })
      .mockResolvedValueOnce({
        lang: 'en',
        audioDuration: 2.0,
        elapsedMs: 48,
      })
      .mockResolvedValueOnce({
        lang: 'de',
        audioDuration: 4.0,
        elapsedMs: 80,
      });

    const onProgress = jest.fn();
    const onSegment = jest.fn();
    const onLanguageChanged = jest.fn();

    const result = await engine.identify(audioId, {
      segmentation: { mode: 'auto' },
      onProgress,
      onSegment,
      onLanguageChanged,
    });

    // Verify segmentation engine was invoked with default policy
    expect(segmentOfflineBuffer).toHaveBeenCalledWith(
      audioId,
      DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY
    );

    // Verify native identify was invoked per span with sample ranges
    expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenCalledTimes(3);
    expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenNthCalledWith(
      1,
      engine.instanceId,
      audioId,
      0,
      32000
    );
    expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenNthCalledWith(
      2,
      engine.instanceId,
      audioId,
      32000,
      64000
    );
    expect(SherpaOnnx.identifyLanguageOffline).toHaveBeenNthCalledWith(
      3,
      engine.instanceId,
      audioId,
      80000,
      144000
    );

    // Verify events
    expect(onProgress).toHaveBeenCalledTimes(3);
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

    // Check result
    expect(result.dominantLanguage).toBe('en'); // 4000ms en vs 4000ms de -> en was first or equal
    expect(result.distribution).toEqual({
      en: 0.5,
      de: 0.5,
    });
    expect(result.switches).toHaveLength(2);
    expect(result.segments).toHaveLength(3);

    // Cleaned up temporary segment buffer
    expect(releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      'seg_off_11111111-1111-1111-1111-111111111111'
    );
  });

  it('populates targetSegmentBuffer with LanguageIdSpeechSegmentPayload when provided', async () => {
    const engine = await createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/models/encoder.onnx' },
        decoder: { kind: 'fs', path: '/models/decoder.onnx' },
      },
    });

    const targetSegId = 'seg_off_22222222-2222-2222-2222-222222222222';
    (segmentOfflineBuffer as jest.Mock).mockResolvedValue({
      segmentBufferId: 'seg_off_33333333-3333-3333-3333-333333333333',
    });
    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue([
      {
        id: 's1',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
      },
    ]);
    (createLiveSegmentBuffer as jest.Mock).mockResolvedValue({
      bufferId: 'seg_live_44444444-4444-4444-4444-444444444444',
    });
    (SherpaOnnx.identifyLanguageOffline as jest.Mock).mockResolvedValue({
      lang: 'fr',
      audioDuration: 1.0,
      elapsedMs: 25,
    });

    await engine.identify(audioId, {
      segmentation: { mode: 'auto' },
      targetSegmentBuffer: targetSegId,
    });

    expect(appendLiveSegment).toHaveBeenCalledWith(
      'seg_live_44444444-4444-4444-4444-444444444444',
      {
        kind: 'speech',
        sourceAudioBufferId: audioId,
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
        payload: {
          source: 'languageId',
          lang: 'fr',
        },
      }
    );
    expect(finalizeLiveSegmentBuffer).toHaveBeenCalledWith(
      'seg_live_44444444-4444-4444-4444-444444444444'
    );
    expect(populateOfflineSegmentBufferIfEmpty).toHaveBeenCalledWith(
      targetSegId,
      'seg_live_44444444-4444-4444-4444-444444444444'
    );
    expect(releasePipelineSegmentBuffer).toHaveBeenCalledWith(
      'seg_live_44444444-4444-4444-4444-444444444444'
    );
  });

  it('labels existing segments via labelOfflineSegments', async () => {
    const engine = await createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/models/encoder.onnx' },
        decoder: { kind: 'fs', path: '/models/decoder.onnx' },
      },
    });

    const segIn = 'seg_off_55555555-5555-5555-5555-555555555555';
    const segOut = 'seg_off_66666666-6666-6666-6666-666666666666';

    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue([
      {
        id: 's1',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 0,
        endSample: 48000,
        sampleRate: 16000,
        durationMs: 3000,
      },
    ]);
    (createLiveSegmentBuffer as jest.Mock).mockResolvedValue({
      bufferId: 'seg_live_77777777-7777-7777-7777-777777777777',
    });
    (SherpaOnnx.identifyLanguageOffline as jest.Mock).mockResolvedValue({
      lang: 'es',
      audioDuration: 3.0,
      elapsedMs: 40,
    });

    const onLabeled = jest.fn();
    const result = await engine.labelOfflineSegments(audioId, segIn, segOut, {
      onLabeled,
    });

    expect(result).toEqual({
      labeledCount: 1,
      dominantLanguage: 'es',
      distribution: { es: 1.0 },
      switches: [
        {
          timestamp: 0,
          from: null,
          to: 'es',
          segmentIndex: 0,
        },
      ],
    });
    expect(onLabeled).toHaveBeenCalledWith({
      segmentIndex: 0,
      totalSegments: 1,
      startTime: 0,
      endTime: 3,
      durationMs: 3000,
      lang: 'es',
    });
    expect(appendLiveSegment).toHaveBeenCalledWith(
      'seg_live_77777777-7777-7777-7777-777777777777',
      {
        kind: 'speech',
        sourceAudioBufferId: audioId,
        startSample: 0,
        endSample: 48000,
        sampleRate: 16000,
        durationMs: 3000,
        payload: {
          source: 'languageId',
          lang: 'es',
        },
      }
    );
  });

  it('rejects labelOfflineSegments if engine is destroyed', async () => {
    const engine = await createLanguageIdentification({
      customConfig: {
        encoder: { kind: 'fs', path: '/models/encoder.onnx' },
        decoder: { kind: 'fs', path: '/models/decoder.onnx' },
      },
    });
    await engine.destroy();

    await expect(
      engine.labelOfflineSegments(
        audioId,
        'seg_off_88888888-8888-8888-8888-888888888888',
        'seg_off_99999999-9999-9999-9999-999999999999'
      )
    ).rejects.toThrow(/destroyed/);
  });
});
