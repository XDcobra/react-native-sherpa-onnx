jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeTts: jest.fn(),
    unloadTts: jest.fn(),
    getTtsSampleRate: jest.fn(),
    getTtsNumSpeakers: jest.fn(),
    populateOfflineAudioBufferIfEmpty: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/tts'),
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/tts',
    assetName: 'model.onnx',
  })),
}));

jest.mock('../../model-languages', () => ({
  resolvePublicLanguageHints: jest.fn(() => []),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
  releasePipelineAudioBuffer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../textbuffer', () => ({
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

jest.mock('../orchestrate', () => ({
  runOfflineTtsPipeline: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { addSegmentLink, createSegmentLinkMap } from '../../segment';
import { createTTS } from '../index';
import { runOfflineTtsPipeline } from '../orchestrate';
import type { OfflineAudioBufferRef } from '../../audiobuffer/types';
import type { OfflineTextBufferRef } from '../../textbuffer/types';

describe('tts mode 2 link map integration', () => {
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
    (createSegmentLinkMap as jest.Mock).mockResolvedValue({
      linkMapId: 'slm_created',
    });
    (addSegmentLink as jest.Mock).mockResolvedValue({
      linkId: 'lnk_1',
      textSegmentId: 'txt_0',
      speechSegmentId: 'sp_0',
      linkType: 'tts_produced',
    });

    (runOfflineTtsPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 10,
      outputBuffer: { bufferId: 'off_staging' },
      segmentMappings: [
        {
          textSegmentId: 'txt_0',
          speechSegmentId: 'sp_0',
          segmentIndex: 0,
          text: 'A',
        },
        {
          textSegmentId: 'txt_1',
          speechSegmentId: 'sp_1',
          segmentIndex: 1,
          text: 'B',
        },
      ],
    });
  });

  it('creates and populates link map when caller does not supply one', async () => {
    const tts = await createTTS({
      modelPath: { type: 'file', path: '/models/tts' },
    });

    const result = await tts.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
    });

    expect(createSegmentLinkMap).toHaveBeenCalledWith({
      textBufferId: 'txt_off_in',
      audioBufferId: 'off_out',
    });
    expect(addSegmentLink).toHaveBeenCalledTimes(2);
    expect(addSegmentLink).toHaveBeenNthCalledWith(
      1,
      { linkMapId: 'slm_created' },
      {
        textSegmentId: 'txt_0',
        speechSegmentId: 'sp_0',
        linkType: 'tts_produced',
      }
    );
    expect(addSegmentLink).toHaveBeenNthCalledWith(
      2,
      { linkMapId: 'slm_created' },
      {
        textSegmentId: 'txt_1',
        speechSegmentId: 'sp_1',
        linkType: 'tts_produced',
      }
    );
    expect(result.linkMap).toEqual({ linkMapId: 'slm_created' });
  });

  it('reuses caller-supplied link map', async () => {
    const tts = await createTTS({
      modelPath: { type: 'file', path: '/models/tts' },
    });

    const supplied = { linkMapId: 'slm_supplied' };
    await tts.synthesize(textIn, audioOut, {
      segmentation: { mode: 'auto' },
      linkMap: supplied,
    });

    expect(createSegmentLinkMap).not.toHaveBeenCalled();
    expect(addSegmentLink).toHaveBeenCalledWith(supplied, {
      textSegmentId: 'txt_0',
      speechSegmentId: 'sp_0',
      linkType: 'tts_produced',
    });
  });
});
