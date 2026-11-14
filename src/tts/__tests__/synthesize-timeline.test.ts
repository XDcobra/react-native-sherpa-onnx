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
  publicLanguageHintsFromNative: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
  releasePipelineAudioBuffer: jest.fn(async () => undefined),
  getPipelineAudioBufferInfo: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: any) =>
    typeof value === 'string' ? value : value?.bufferId ?? String(value)
  ),
  getPipelineTextBufferInfo: jest.fn(),
}));

jest.mock('../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

jest.mock('../orchestrate', () => ({
  runOfflineTtsPipeline: jest.fn(),
}));

jest.mock('../synthesizeWithProgress', () => ({
  createTtsProgressEmitter: jest.fn(() => jest.fn()),
  synthesizeTtsWithProgress: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { getPipelineAudioBufferInfo } from '../../audiobuffer';
import { getPipelineTextBufferInfo } from '../../textbuffer';
import { createTTS } from '../index';
import { runOfflineTtsPipeline } from '../orchestrate';
import type { OfflineAudioBufferRef } from '../../audiobuffer/types';
import type { OfflineTextBufferRef } from '../../textbuffer/types';

describe('tts synthesize timeline', () => {
  const textIn = { bufferId: 'txt_off_in' } as OfflineTextBufferRef;
  const audioOut = { bufferId: 'off_out' } as OfflineAudioBufferRef;
  const native = SherpaOnnx as unknown as Record<string, jest.Mock>;

  beforeEach(() => {
    jest.clearAllMocks();
    native.initializeTts!.mockResolvedValue({
      success: true,
      detectedModels: [{ type: 'vits', modelDir: '/models/tts' }],
    });
    native.getTtsSampleRate!.mockResolvedValue(22050);
    native.getTtsNumSpeakers!.mockResolvedValue(1);
    native.populateOfflineAudioBufferIfEmpty!.mockResolvedValue(undefined);
    (getPipelineAudioBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'off_out',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 22050,
      channelCount: 1,
      numSamples: 44100,
      durationMs: 2000,
    });
  });

  const tts = () =>
    createTTS({ modelSource: { kind: 'fs', path: '/models/tts' } });

  it('maps orchestrated segments to a public timeline (auto mode)', async () => {
    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 5,
      outputBuffer: { bufferId: 'off_staging' },
      segmentMappings: [],
      timeline: [
        {
          segmentIndex: 0,
          utf16Start: 0,
          utf16End: 12,
          startSample: 0,
          numSamples: 22050,
          skipped: false,
        },
        {
          segmentIndex: 1,
          utf16Start: 12,
          utf16End: 30,
          startSample: 22050,
          numSamples: 22050,
          skipped: false,
        },
      ],
    });
    const engine = await tts();
    const result = await engine.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
      timeline: true,
    });
    expect(result).toMatchObject({
      timeline: {
        sampleRate: 22050,
        exact: true,
        segments: [
          { utf16Start: 0, utf16End: 12, startSample: 0, numSamples: 22050 },
          {
            utf16Start: 12,
            utf16End: 30,
            startSample: 22050,
            numSamples: 22050,
          },
        ],
      },
    });
  });

  it('marks the timeline inexact when segments overlap', async () => {
    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 0,
      completedSegments: 0,
      skippedSegments: [],
      processingTimeMs: 1,
      segmentMappings: [],
      timeline: [],
    });
    const engine = await tts();
    const result = (await engine.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
      overlapChars: 20,
      timeline: true,
    })) as { timeline?: { exact: boolean } };
    expect(result.timeline?.exact).toBe(false);
  });

  it('omits the timeline unless requested', async () => {
    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 0,
      completedSegments: 0,
      skippedSegments: [],
      processingTimeMs: 1,
      segmentMappings: [],
      timeline: [],
    });
    const engine = await tts();
    const result = await engine.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
    });
    expect(result).not.toHaveProperty('timeline');
  });

  it('returns one segment for the whole text in off mode', async () => {
    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'txt_off_in',
      kind: 'offlineTextBuffer',
      utf16Length: 42,
    });
    const engine = await tts();
    const result = await engine.synthesize(textIn, audioOut, {
      timeline: true,
    });
    expect(result).toMatchObject({
      timeline: {
        sampleRate: 22050,
        exact: true,
        segments: [
          {
            utf16Start: 0,
            utf16End: 42,
            startSample: 0,
            numSamples: 44100,
            skipped: false,
          },
        ],
      },
    });
  });
});
