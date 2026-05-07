jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    initializeStt: jest.fn(),
    unloadStt: jest.fn(),
    transcribe: jest.fn(),
    populateOfflineTextBufferIfEmpty: jest.fn(),
  },
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(async () => '/models/stt'),
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(async () => ({
    modelDir: '/models/stt',
    assetName: 'model.onnx',
  })),
  resolveFileSourceForModelInit: jest.fn(async () => '/models/stt'),
}));

jest.mock('../../pipeline/offlineOrchestrator', () => ({
  runOfflineAudioToTextPipeline: jest.fn(),
}));

jest.mock('../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

jest.mock('../../segment/runtime-state', () => ({
  setOfflineTextSegments: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  getPipelineTextBufferInfo: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createSTT } from '../index';
import { runOfflineAudioToTextPipeline } from '../../pipeline/offlineOrchestrator';
import { createSegmentLinkMap, addSegmentLink } from '../../segment';
import {
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from '../../textbuffer';
import { setOfflineTextSegments } from '../../segment/runtime-state';

describe('stt segmented transcribe', () => {
  const mockNative = SherpaOnnx as unknown as {
    initializeStt: jest.Mock;
    unloadStt: jest.Mock;
    transcribe: jest.Mock;
    populateOfflineTextBufferIfEmpty: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.initializeStt.mockResolvedValue({
      success: true,
      detectedModels: [],
    });
    mockNative.unloadStt.mockResolvedValue(null);
    mockNative.transcribe.mockResolvedValue(null);
    mockNative.populateOfflineTextBufferIfEmpty.mockResolvedValue(null);

    (createSegmentLinkMap as jest.Mock).mockResolvedValue({
      linkMapId: 'slm_1',
    });
    (addSegmentLink as jest.Mock).mockResolvedValue({
      linkId: 'link_1',
      textSegmentId: 'txtseg_1',
      speechSegmentId: 'sp_1',
      linkType: 'stt_produced',
    });

    (getPipelineTextBufferInfo as jest.Mock).mockResolvedValue({
      bufferId: 'txt_tmp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 8,
    });
    (getOfflineTextBufferTextSlice as jest.Mock).mockResolvedValue('hi there');
    (releasePipelineTextBuffer as jest.Mock).mockResolvedValue(undefined);
  });

  it('runs segmented orchestration, populates textOut and creates stt_produced links', async () => {
    (runOfflineAudioToTextPipeline as jest.Mock).mockResolvedValue({
      status: 'complete',
      totalSegments: 2,
      completedSegments: 2,
      skippedSegments: [],
      processingTimeMs: 12,
      outputBuffer: {
        bufferId: 'txt_tmp',
        info: {
          bufferId: 'txt_tmp',
          kind: 'offlineTextBuffer',
          state: 'immutable',
          utf16Length: 8,
          tokenCount: 0,
          timestampCount: 0,
          durationCount: 0,
          hasLang: false,
          hasEmotion: false,
          hasEvent: false,
        },
      },
      segmentMappings: [
        {
          speechSegmentId: 'sp_1',
          textSegmentId: 'tmp_1',
          segmentIndex: 0,
          text: 'hi ',
        },
        {
          speechSegmentId: 'sp_2',
          textSegmentId: 'tmp_2',
          segmentIndex: 1,
          text: 'there',
        },
      ],
    });

    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    const result = await stt.transcribe(
      'off_11111111-1111-1111-1111-111111111111',
      'txt_off_11111111-1111-1111-1111-111111111111',
      {
        segmentation: {
          mode: 'auto',
          policy: {
            evaluator: 'speech_vad_model',
            modelPath: { kind: 'fs', path: '/models/vad/silero_vad.onnx' },
          },
        },
      }
    );

    expect(result.status).toBe('complete');
    expect(result.completedSegments).toBe(2);
    expect(result.linkMap?.linkMapId).toBe('slm_1');

    expect(mockNative.populateOfflineTextBufferIfEmpty).toHaveBeenCalledWith(
      'txt_off_11111111-1111-1111-1111-111111111111',
      'hi there',
      {}
    );
    expect(releasePipelineTextBuffer).toHaveBeenCalledWith('txt_tmp');
    expect(createSegmentLinkMap).toHaveBeenCalled();
    expect(addSegmentLink).toHaveBeenCalledTimes(2);
    expect(setOfflineTextSegments).toHaveBeenCalled();
  });

  it('uses native single-shot path when segmentation mode is off', async () => {
    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    const result = await stt.transcribe(
      'off_11111111-1111-1111-1111-111111111111',
      'txt_off_11111111-1111-1111-1111-111111111111'
    );

    expect(result.status).toBe('complete');
    expect(mockNative.transcribe).toHaveBeenCalledWith(
      expect.stringMatching(/^stt_/),
      'off_11111111-1111-1111-1111-111111111111',
      'txt_off_11111111-1111-1111-1111-111111111111'
    );
    expect(runOfflineAudioToTextPipeline).not.toHaveBeenCalled();
  });

  it('throws when segmented orchestration returns failed status', async () => {
    (runOfflineAudioToTextPipeline as jest.Mock).mockResolvedValue({
      status: 'failed',
      totalSegments: 2,
      completedSegments: 0,
      skippedSegments: [],
      failedSegment: {
        segmentIndex: 0,
        segmentId: 'sp_1',
        error: 'boom',
        retryCount: 0,
      },
      processingTimeMs: 3,
      segmentMappings: [],
    });

    const stt = await createSTT({
      modelSource: { kind: 'fs', path: '/models/stt' },
    });

    await expect(
      stt.transcribe(
        'off_11111111-1111-1111-1111-111111111111',
        'txt_off_11111111-1111-1111-1111-111111111111',
        {
          segmentation: {
            mode: 'auto',
            policy: { evaluator: 'speech_energy_silence' },
          },
        }
      )
    ).rejects.toThrow('boom');
  });
});
