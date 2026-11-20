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
  resolveBundledAssetPath: jest.fn(async () => '/models/stt'),
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
  getPipelineAudioBufferInfo: jest.fn(),
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
import { getPipelineAudioBufferInfo } from '../../audiobuffer';
import { createOrchestrationCancelledError } from '../../pipeline/cancellation';

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
          spatialSpanCount: 0,
          hasLang: false,
          hasEmotion: false,
          hasEvent: false,
          hasSpatialSpans: false,
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

  describe('signal and onSegment', () => {
    const AUDIO = 'off_11111111-1111-1111-1111-111111111111';
    const TEXT_OUT = 'txt_off_11111111-1111-1111-1111-111111111111';
    const segmented = {
      segmentation: {
        mode: 'auto' as const,
        policy: { evaluator: 'speech_energy_silence' as const },
      },
    };

    const completeRun = (config: any) => {
      config.onSegment?.({
        segmentIndex: 0,
        segmentCount: 3,
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        text: 'hi ',
        speechSegmentId: 'sp_1',
        textSegmentId: 'tmp_1',
      });
      // segment 1 skipped: no callback
      config.onSegment?.({
        segmentIndex: 2,
        segmentCount: 3,
        startMs: 2500,
        endMs: 4000,
        durationMs: 1500,
        text: 'there',
        speechSegmentId: 'sp_3',
        textSegmentId: 'tmp_3',
      });
      return {
        status: 'complete',
        totalSegments: 3,
        completedSegments: 2,
        skippedSegments: [
          {
            segmentIndex: 1,
            segmentId: 'sp_2',
            error: 'boom',
            retryCount: 0,
          },
        ],
        processingTimeMs: 4,
        outputBuffer: { bufferId: 'txt_tmp' },
        segmentMappings: [
          {
            speechSegmentId: 'sp_1',
            textSegmentId: 'tmp_1',
            segmentIndex: 0,
            text: 'hi ',
          },
          {
            speechSegmentId: 'sp_3',
            textSegmentId: 'tmp_3',
            segmentIndex: 2,
            text: 'there',
          },
        ],
      };
    };

    beforeEach(() => {
      (getPipelineAudioBufferInfo as jest.Mock).mockResolvedValue({
        bufferId: AUDIO,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 64000,
        durationMs: 4000,
      });
    });

    it('passes signal to the orchestrator', async () => {
      (runOfflineAudioToTextPipeline as jest.Mock).mockImplementation(
        async (_input, _consumer, config) => completeRun(config)
      );
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const controller = new AbortController();

      await stt.transcribe(AUDIO, TEXT_OUT, {
        ...segmented,
        signal: controller.signal,
      });

      expect(runOfflineAudioToTextPipeline).toHaveBeenCalledWith(
        AUDIO,
        expect.any(Function),
        expect.objectContaining({ signal: controller.signal })
      );
    });

    it('calls onSegment in order with the ids written to textOut', async () => {
      (runOfflineAudioToTextPipeline as jest.Mock).mockImplementation(
        async (_input, _consumer, config) => completeRun(config)
      );
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const onSegment = jest.fn();

      const result = await stt.transcribe(AUDIO, TEXT_OUT, {
        ...segmented,
        onSegment,
      });

      expect(result.status).toBe('complete');
      expect(onSegment.mock.calls.map(([e]) => e)).toEqual([
        {
          segmentIndex: 0,
          segmentCount: 3,
          startMs: 0,
          endMs: 1000,
          durationMs: 1000,
          text: 'hi ',
          speechSegmentId: 'sp_1',
          textSegmentId: `txtseg_${TEXT_OUT}_0`,
        },
        {
          segmentIndex: 2,
          segmentCount: 3,
          startMs: 2500,
          endMs: 4000,
          durationMs: 1500,
          text: 'there',
          speechSegmentId: 'sp_3',
          textSegmentId: `txtseg_${TEXT_OUT}_1`,
        },
      ]);
      const written = (setOfflineTextSegments as jest.Mock).mock.calls[0]![1];
      expect(
        written.map((seg: { segmentId: string }) => seg.segmentId)
      ).toEqual(onSegment.mock.calls.map(([e]) => e.textSegmentId));
    });

    it('a throwing onSegment does not fail a segmented run', async () => {
      (runOfflineAudioToTextPipeline as jest.Mock).mockImplementation(
        async (_input, _consumer, config) => completeRun(config)
      );
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const onSegment = jest.fn(() => {
        throw new Error('callback failed');
      });

      const result = await stt.transcribe(AUDIO, TEXT_OUT, {
        ...segmented,
        onSegment,
      });

      expect(result.status).toBe('complete');
      expect(onSegment).toHaveBeenCalledTimes(2);
      expect(addSegmentLink).toHaveBeenCalledTimes(2);
    });

    it('rejects with the cancel error and leaves textOut empty', async () => {
      (runOfflineAudioToTextPipeline as jest.Mock).mockRejectedValue(
        createOrchestrationCancelledError()
      );
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        stt.transcribe(AUDIO, TEXT_OUT, {
          ...segmented,
          signal: controller.signal,
        })
      ).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ORCHESTRATION_CANCELLED',
      });
      expect(
        mockNative.populateOfflineTextBufferIfEmpty
      ).not.toHaveBeenCalled();
      expect(createSegmentLinkMap).not.toHaveBeenCalled();
    });

    it('rejects before the single native call when segmentation is off', async () => {
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        stt.transcribe(AUDIO, TEXT_OUT, { signal: controller.signal })
      ).rejects.toMatchObject({ code: 'ORCHESTRATION_CANCELLED' });
      expect(mockNative.transcribe).not.toHaveBeenCalled();
    });

    it('calls onSegment once with the whole text when segmentation is off', async () => {
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });
      const onSegment = jest.fn();
      const onProgress = jest.fn();

      await stt.transcribe(AUDIO, TEXT_OUT, { onSegment, onProgress });

      expect(onSegment).toHaveBeenCalledTimes(1);
      expect(onSegment).toHaveBeenCalledWith({
        segmentIndex: 0,
        segmentCount: 1,
        startMs: 0,
        endMs: 4000,
        durationMs: 4000,
        text: 'hi there',
      });
      expect(getOfflineTextBufferTextSlice).toHaveBeenCalledWith(
        TEXT_OUT,
        0,
        8
      );
      expect(onProgress).toHaveBeenCalledTimes(2);
      for (const [p] of onProgress.mock.calls) {
        expect(p).toMatchObject({
          currentSegmentStartMs: 0,
          currentSegmentEndMs: 4000,
        });
      }
    });

    it('a throwing onSegment does not fail a single-pass run', async () => {
      const stt = await createSTT({
        modelSource: { kind: 'fs', path: '/models/stt' },
      });

      const result = await stt.transcribe(AUDIO, TEXT_OUT, {
        onSegment: () => {
          throw new Error('callback failed');
        },
      });

      expect(result.status).toBe('complete');
    });
  });
});
