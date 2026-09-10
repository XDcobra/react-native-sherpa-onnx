jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeAudioTagging: jest.fn(),
    tagAudioOffline: jest.fn(),
    unloadAudioTagging: jest.fn(),
    getCustomModelPathRequirements: jest.fn(async () => ({
      category: 'audiotagging',
      modelType: 'ced',
      fields: [
        { key: 'model', required: true },
        { key: 'labels', required: true },
      ],
    })),
    validateCustomModelPaths: jest.fn(async () => ({
      ok: true,
      category: 'audiotagging',
      modelType: 'ced',
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
  resolveFileSourceForModelInit: jest.fn(async () => '/models/ced-mini'),
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
  createAudioTagging,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  AudioTaggingErrorCode,
  type SegmentedAudioTaggingResult,
} from '../index';

describe('createAudioTagging - segmented mode', () => {
  const audioId = 'off_11111111-1111-1111-1111-111111111111';
  const targetSegId = 'seg_off_22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    (SherpaOnnx.initializeAudioTagging as jest.Mock).mockResolvedValue({
      success: true,
      modelType: 'ced',
    });
    (releasePipelineSegmentBuffer as jest.Mock).mockResolvedValue(undefined);
  });

  async function makeEngine() {
    return createAudioTagging({
      modelSource: { kind: 'fs', path: '/models/ced-mini' },
      topK: 5,
    });
  }

  it('tags each speech span with start/end samples and fires callbacks', async () => {
    const engine = await makeEngine();
    const mockSpans: SegmentMeta[] = [
      {
        id: 's1',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1000,
      },
      {
        id: 's2',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 16000,
        endSample: 32000,
        sampleRate: 16000,
        durationMs: 1000,
      },
    ];

    (segmentOfflineBuffer as jest.Mock).mockResolvedValue({
      segmentBufferId: 'seg_off_temp',
    });
    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue(mockSpans);
    (SherpaOnnx.tagAudioOffline as jest.Mock)
      .mockResolvedValueOnce({
        events: [{ name: 'Speech', index: 0, prob: 0.9 }],
        audioDuration: 1,
        elapsedMs: 5,
        topK: 3,
      })
      .mockResolvedValueOnce({
        events: [{ name: 'Music', index: 1, prob: 0.7 }],
        audioDuration: 1,
        elapsedMs: 6,
        topK: 3,
      });

    const onProgress = jest.fn();
    const onSegment = jest.fn();

    const result = (await engine.tag(audioId, {
      topK: 3,
      segmentation: { mode: 'auto' },
      onProgress,
      onSegment,
    })) as SegmentedAudioTaggingResult;

    expect(segmentOfflineBuffer).toHaveBeenCalledWith(
      audioId,
      DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY
    );
    expect(SherpaOnnx.tagAudioOffline).toHaveBeenCalledTimes(2);
    expect(SherpaOnnx.tagAudioOffline).toHaveBeenNthCalledWith(
      1,
      engine.instanceId,
      audioId,
      3,
      0,
      16000
    );
    expect(SherpaOnnx.tagAudioOffline).toHaveBeenNthCalledWith(
      2,
      engine.instanceId,
      audioId,
      3,
      16000,
      32000
    );
    expect(result.totalSegments).toBe(2);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.result.primary?.name).toBe('Speech');
    expect(result.segments[1]?.result.primary?.name).toBe('Music');
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onSegment).toHaveBeenCalledTimes(2);
    expect(releasePipelineSegmentBuffer).toHaveBeenCalledWith('seg_off_temp');
  });

  it('populates targetSegmentBuffer with audioTagging payload', async () => {
    const engine = await makeEngine();
    (segmentOfflineBuffer as jest.Mock).mockResolvedValue({
      segmentBufferId: 'seg_off_temp',
    });
    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue([
      {
        id: 's1',
        sourceAudioBufferId: audioId,
        kind: 'speech',
        startSample: 0,
        endSample: 8000,
        sampleRate: 16000,
        durationMs: 500,
      },
    ] as SegmentMeta[]);
    (createLiveSegmentBuffer as jest.Mock).mockResolvedValue({
      bufferId: 'seg_live_staging',
    });
    (appendLiveSegment as jest.Mock).mockResolvedValue({
      segmentId: 'x',
      segmentIndex: 0,
    });
    (finalizeLiveSegmentBuffer as jest.Mock).mockResolvedValue(undefined);
    (populateOfflineSegmentBufferIfEmpty as jest.Mock).mockResolvedValue(
      undefined
    );
    (SherpaOnnx.tagAudioOffline as jest.Mock).mockResolvedValue({
      events: [
        { name: 'Siren', index: 2, prob: 0.8 },
        { name: 'Speech', index: 0, prob: 0.2 },
      ],
      audioDuration: 0.5,
      elapsedMs: 4,
      topK: 5,
    });

    await engine.tag(audioId, {
      segmentation: { mode: 'auto' },
      targetSegmentBuffer: targetSegId,
    });

    expect(appendLiveSegment).toHaveBeenCalledWith(
      'seg_live_staging',
      expect.objectContaining({
        kind: 'speech',
        payload: {
          source: 'audioTagging',
          primaryName: 'Siren',
          events: [
            { name: 'Siren', index: 2, prob: 0.8 },
            { name: 'Speech', index: 0, prob: 0.2 },
          ],
        },
      })
    );
    expect(finalizeLiveSegmentBuffer).toHaveBeenCalledWith('seg_live_staging');
    expect(populateOfflineSegmentBufferIfEmpty).toHaveBeenCalledWith(
      targetSegId,
      'seg_live_staging'
    );
  });

  it('returns empty segmented result when no speech spans', async () => {
    const engine = await makeEngine();
    (segmentOfflineBuffer as jest.Mock).mockResolvedValue({
      segmentBufferId: 'seg_off_temp',
    });
    (getOfflineSegmentBufferSegments as jest.Mock).mockResolvedValue([]);

    const result = (await engine.tag(audioId, {
      segmentation: { mode: 'auto' },
    })) as SegmentedAudioTaggingResult;

    expect(result.totalSegments).toBe(0);
    expect(result.segments).toEqual([]);
    expect(SherpaOnnx.tagAudioOffline).not.toHaveBeenCalled();
  });

  it('rejects segmentation.mode manual', async () => {
    const engine = await makeEngine();
    await expect(
      engine.tag(audioId, { segmentation: { mode: 'manual' } })
    ).rejects.toThrow(AudioTaggingErrorCode.INVALID_ARGUMENT);
  });

  it('rejects speech_vad_model evaluator', async () => {
    const engine = await makeEngine();
    await expect(
      engine.tag(audioId, {
        segmentation: {
          mode: 'auto',
          policy: { evaluator: 'speech_vad_model' } as any,
        },
      })
    ).rejects.toThrow(/supports only/);
  });
});
