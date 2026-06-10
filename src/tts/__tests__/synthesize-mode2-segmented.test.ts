jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeTts: jest.fn(),
    synthesizeTts: jest.fn(),
    unloadTts: jest.fn(),
    getTtsSampleRate: jest.fn(),
    getTtsNumSpeakers: jest.fn(),
    populateOfflineAudioBufferIfEmpty: jest.fn(),
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
  resolvePublicLanguageHints: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
  releasePipelineAudioBuffer: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
}));

jest.mock('../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

jest.mock('../orchestrate', () => ({
  runOfflineTtsPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { releasePipelineAudioBuffer } from '../../audiobuffer';
import { createTTS } from '../index';
import { runOfflineTtsPipeline } from '../orchestrate';
import type { OfflineAudioBufferRef } from '../../audiobuffer/types';
import type { OfflineTextBufferRef } from '../../textbuffer/types';

describe('tts synthesize mode 2 (segmented offline)', () => {
  const textIn = {
    bufferId: 'txt_off_in' as OfflineTextBufferRef['bufferId'],
  } as OfflineTextBufferRef;
  const audioOut = {
    bufferId: 'off_out' as OfflineAudioBufferRef['bufferId'],
  } as OfflineAudioBufferRef;

  const native = SherpaOnnx as unknown as {
    initializeTts: jest.Mock;
    unloadTts: jest.Mock;
    getTtsSampleRate: jest.Mock;
    getTtsNumSpeakers: jest.Mock;
    populateOfflineAudioBufferIfEmpty: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeTts.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'vits', modelDir: '/models/tts' }],
    });
    native.unloadTts.mockResolvedValue(undefined);
    native.getTtsSampleRate.mockResolvedValue(22050);
    native.getTtsNumSpeakers.mockResolvedValue(1);
    native.populateOfflineAudioBufferIfEmpty.mockResolvedValue(undefined);
    (releasePipelineAudioBuffer as jest.Mock).mockResolvedValue(undefined);
  });

  it('runs orchestration path and populates caller-owned output buffer', async () => {
    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 14,
      outputBuffer: { bufferId: 'off_staging' },
      segmentMappings: [
        { textSegmentId: 'txt_0', speechSegmentId: 'sp_0', segmentIndex: 0 },
        { textSegmentId: 'txt_1', speechSegmentId: 'sp_1', segmentIndex: 1 },
      ],
    });

    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const result = await tts.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'skip',
    });

    expect(runOfflineTtsPipeline).toHaveBeenCalledWith(
      'txt_off_in',
      expect.stringMatching(/^tts_/),
      expect.objectContaining({
        segmentation: { mode: 'auto' },
        errorRecovery: 'skip',
      })
    );
    expect(native.populateOfflineAudioBufferIfEmpty).toHaveBeenCalledWith(
      'off_out',
      'off_staging',
      undefined
    );
    expect(releasePipelineAudioBuffer).toHaveBeenCalledWith('off_staging');
    expect(result).toMatchObject({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
    });
  });

  it('returns failed segmented status without populating when no output buffer is produced', async () => {
    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'failed',
      totalSegments: 3,
      completedSegments: 0,
      skippedSegments: [],
      failedSegment: {
        segmentIndex: 0,
        segmentId: 'txt_0',
        error: 'boom',
        retryCount: 0,
      },
      processingTimeMs: 3,
      segmentMappings: [],
    });

    const tts = await createTTS({
      modelSource: { kind: 'fs', path: '/models/tts' },
    });

    const result = await tts.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'abort',
    });

    expect(result.status).toBe('failed');
    expect(native.populateOfflineAudioBufferIfEmpty).not.toHaveBeenCalled();
    expect(releasePipelineAudioBuffer).not.toHaveBeenCalled();
  });
});
