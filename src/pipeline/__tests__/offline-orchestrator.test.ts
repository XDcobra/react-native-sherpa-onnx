jest.mock('../../audiobuffer', () => ({
  appendOfflineToLiveAudioBuffer: jest.fn(),
  appendSamplesToLiveAudioBuffer: jest.fn(),
  createEmptyLiveAudioBuffer: jest.fn(),
  createEmptyOfflineAudioBuffer: jest.fn(),
  createOfflineAudioBufferFromSamples: jest.fn(),
  finalizeLiveAudioBuffer: jest.fn(),
  getOfflineAudioBufferSamplesSlice: jest.fn(),
  getPipelineAudioBufferInfo: jest.fn(),
  releasePipelineAudioBuffer: jest.fn(),
  transferOfflineAudioBufferFromLive: jest.fn(),
}));

jest.mock('../../segment', () => ({
  getSegments: jest.fn(),
  segmentOfflineBuffer: jest.fn(),
}));

jest.mock('../../textbuffer', () => ({
  createEmptyOfflineTextBuffer: jest.fn(),
  createOfflineTextBufferFromText: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  releasePipelineTextBuffer: jest.fn(),
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    resolveAppBaseDir: jest.fn(),
  },
}));

import {
  runOfflineAudioToTextPipeline,
  runOfflineAudioPipeline,
  runOfflineAudioMultiOutputPipeline,
  runOfflineTextToAudioPipeline,
  runOfflineTextPipeline,
} from '../offlineOrchestrator';
import SherpaOnnx from '../../NativeSherpaOnnx';

describe('offline orchestrator', () => {
  const audio = jest.requireMock('../../audiobuffer') as any;
  const segment = jest.requireMock('../../segment') as any;
  const text = jest.requireMock('../../textbuffer') as any;
  const native = SherpaOnnx as unknown as { resolveAppBaseDir: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    native.resolveAppBaseDir.mockResolvedValue('/tmp');

    audio.createEmptyLiveAudioBuffer.mockResolvedValue({
      bufferId: 'live_acc',
      info: {
        bufferId: 'live_acc',
        kind: 'livePcmBuffer',
        state: 'recording',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 0,
        durationMs: 0,
        totalSamplesWritten: 0,
        ringEvictedSamples: 0,
        hasActiveSpool: true,
      },
      unsubscribeEvents: jest.fn(),
    });

    audio.createOfflineAudioBufferFromSamples.mockImplementation(
      (samples: Float32Array) => ({
        bufferId: `off_tmp_in_${samples.length}`,
        info: {
          bufferId: `off_tmp_in_${samples.length}`,
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: samples.length,
          durationMs: samples.length / 16,
        },
      })
    );

    audio.createEmptyOfflineAudioBuffer.mockResolvedValue({
      bufferId: 'off_tmp_out',
      info: {
        bufferId: 'off_tmp_out',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 0,
        durationMs: 0,
      },
    });

    audio.getOfflineAudioBufferSamplesSlice.mockReturnValue(
      new Float32Array(4)
    );
    audio.appendOfflineToLiveAudioBuffer.mockResolvedValue(undefined);
    audio.appendSamplesToLiveAudioBuffer.mockReturnValue(undefined);
    audio.finalizeLiveAudioBuffer.mockResolvedValue('live_acc');
    audio.releasePipelineAudioBuffer.mockResolvedValue(undefined);
    audio.transferOfflineAudioBufferFromLive.mockResolvedValue({
      bufferId: 'off_final',
      info: {
        bufferId: 'off_final',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 8,
        durationMs: 0.5,
      },
    });

    text.createEmptyOfflineTextBuffer.mockResolvedValue({
      bufferId: 'txt_empty',
      info: {
        bufferId: 'txt_empty',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 0,
        tokenCount: 0,
        timestampCount: 0,
        durationCount: 0,
        spatialSpanCount: 0,
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
        hasSpatialSpans: false,
      },
    });
    text.createOfflineTextBufferFromText.mockResolvedValue({
      bufferId: 'txt_final',
      info: {
        bufferId: 'txt_final',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 4,
        tokenCount: 0,
        timestampCount: 0,
        durationCount: 0,
        spatialSpanCount: 0,
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
        hasSpatialSpans: false,
      },
    });
    text.getPipelineTextBufferInfo.mockResolvedValue({
      bufferId: 'txt_in',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      utf16Length: 4,
      tokenCount: 0,
      timestampCount: 0,
      durationCount: 0,
      hasLang: false,
      hasEmotion: false,
      hasEvent: false,
    });
    text.getOfflineTextBufferTextSlice.mockResolvedValue('test');
    text.releasePipelineTextBuffer.mockResolvedValue(undefined);

    segment.segmentOfflineBuffer.mockResolvedValue({
      segmentBufferId: 'seg_off_derived',
      domain: 'speech',
      parentBufferId: 'off_input',
    });
    segment.getSegments.mockResolvedValue([]);
  });

  it('transfers finalized audio accumulator on complete run', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 8,
          durationMs: 0.5,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 4,
        durationMs: 0.25,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_1',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const consumer = jest.fn().mockResolvedValue(undefined);
    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
    });

    expect(result.status).toBe('complete');
    expect(result.outputBuffer?.bufferId).toBe('off_final');
    expect(audio.transferOfflineAudioBufferFromLive).toHaveBeenCalledWith(
      'live_acc',
      'fullIfSpooled'
    );
    expect(segment.segmentOfflineBuffer).toHaveBeenCalledWith(
      'off_input',
      expect.objectContaining({ evaluator: 'speech_energy_silence' })
    );
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('passes configured segmentation policy to native offline segmentation', async () => {
    audio.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: 'off_input',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 0,
      durationMs: 0,
    });

    const customPolicy = {
      evaluator: 'speech_energy_silence' as const,
      energyThresholdDb: -36,
      minSegmentMs: 500,
      maxSegmentMs: 5000,
    };

    await runOfflineAudioPipeline('off_input', jest.fn(), {
      segmentation: {
        mode: 'auto',
        policy: customPolicy,
      },
    });

    expect(segment.segmentOfflineBuffer).toHaveBeenCalledWith(
      'off_input',
      customPolicy
    );
  });

  it('skips failed segment and inserts silence when recovery=skip', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 8,
          durationMs: 0.5,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 2,
        durationMs: 0.125,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_1',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
      {
        segmentId: 'seg_2',
        domain: 'speech',
        startOffset: 4,
        endOffset: 8,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 1,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const consumer = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'skip',
    });

    expect(result.status).toBe('complete');
    expect(result.skippedSegments).toHaveLength(1);
    expect(result.skippedSegments[0]!.segmentId).toBe('seg_1');
    expect(audio.appendSamplesToLiveAudioBuffer).toHaveBeenCalled();
  });

  it('creates empty offline text output when all segments are skipped', async () => {
    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'txt_seg_1',
        domain: 'text',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text: 'test',
        utf16Length: 4,
      },
    ]);

    const consumer = jest.fn().mockRejectedValue(new Error('text_fail'));

    const result = await runOfflineTextPipeline('txt_in', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'skip',
      textSkipPlaceholder: '',
    });

    expect(result.status).toBe('complete');
    expect(result.skippedSegments).toHaveLength(1);
    expect(text.createEmptyOfflineTextBuffer).toHaveBeenCalled();
  });

  it('uses deterministic orch_* temp retention path for audio accumulator', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 2,
        durationMs: 0.125,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_1',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    await runOfflineAudioPipeline(
      'off_input',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
      }
    );

    const call = audio.createEmptyLiveAudioBuffer.mock.calls[0]?.[0];
    expect(call?.retention?.mode).toBe('path');
    expect(call?.retention?.trim).toBe('session');
    expect(call?.retention?.path).toMatch(
      /\/tmp\/orch_audio_\d+_\d+_acc\.wav$/
    );
  });

  it('retries failed segment and succeeds before retry budget is exhausted', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 4,
        durationMs: 0.25,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_retry',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const consumer = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);

    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'retry',
      maxRetriesPerSegment: 1,
    });

    expect(result.status).toBe('complete');
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(result.skippedSegments).toHaveLength(0);
  });

  it('uses retryExhaustedFallback=skip after retry budget is exhausted', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 0,
        durationMs: 0,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_retry_skip',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const consumer = jest.fn().mockRejectedValue(new Error('hard_fail'));

    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'retry',
      maxRetriesPerSegment: 1,
      retryExhaustedFallback: 'skip',
    });

    expect(result.status).toBe('complete');
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(result.skippedSegments).toHaveLength(1);
    expect(audio.appendSamplesToLiveAudioBuffer).toHaveBeenCalled();
  });

  it('returns partial_result after failed segment and keeps partial output', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 0,
        durationMs: 0,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_partial',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const result = await runOfflineAudioPipeline(
      'off_input',
      jest.fn().mockRejectedValue(new Error('fatal_segment')),
      {
        segmentation: { mode: 'auto' },
        errorRecovery: 'partial_result',
      }
    );

    expect(result.status).toBe('partial');
    expect(result.failedSegment?.segmentId).toBe('seg_partial');
    expect(result.outputBuffer).toBeDefined();
  });

  it('returns failed when transfer from finalized accumulator fails', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 4,
        durationMs: 0.25,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_transfer_fail',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    audio.transferOfflineAudioBufferFromLive.mockRejectedValueOnce(
      new Error('transfer_failed')
    );

    const result = await runOfflineAudioPipeline(
      'off_input',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
      }
    );

    expect(result.status).toBe('failed');
    expect(result.failedSegment?.segmentId).toContain('_fatal');
    expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
  });

  it('propagates linkMap reference into orchestration result', async () => {
    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'txt_seg_1',
        domain: 'text',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text: 'test',
        utf16Length: 4,
      },
    ]);

    const linkMap = { linkMapId: 'slm_1' } as any;
    const result = await runOfflineTextPipeline(
      'txt_in',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
        linkMap,
      }
    );

    expect(result.linkMap).toBe(linkMap);
  });

  it('runs offline audio->text orchestration and returns segment mappings', async () => {
    audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
      if (id === 'off_input') {
        return Promise.resolve({
          bufferId: 'off_input',
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 8,
          durationMs: 0.5,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 4,
        durationMs: 0.25,
      });
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_1',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    text.getPipelineTextBufferInfo.mockImplementation((id: string) => {
      if (id === 'txt_empty') {
        return Promise.resolve({
          bufferId: id,
          kind: 'offlineTextBuffer',
          state: 'immutable',
          utf16Length: 4,
          tokenCount: 0,
          timestampCount: 0,
          durationCount: 0,
          spatialSpanCount: 0,
          hasLang: false,
          hasEmotion: false,
          hasEvent: false,
          hasSpatialSpans: false,
        });
      }
      return Promise.resolve({
        bufferId: id,
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 4,
        tokenCount: 0,
        timestampCount: 0,
        durationCount: 0,
        spatialSpanCount: 0,
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
        hasSpatialSpans: false,
      });
    });
    text.getOfflineTextBufferTextSlice.mockResolvedValue('test');

    const result = await runOfflineAudioToTextPipeline(
      'off_input',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
      }
    );

    expect(result.status).toBe('complete');
    expect(result.outputBuffer?.bufferId).toBe('txt_final');
    expect(result.segmentMappings).toHaveLength(1);
    expect(result.segmentMappings[0]).toMatchObject({
      speechSegmentId: 'seg_1',
      segmentIndex: 0,
      text: 'test',
    });
  });

  it('audio->text skip recovery inserts placeholder and reports skip', async () => {
    audio.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: 'off_input',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 4,
      durationMs: 0.25,
    });

    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'seg_skip',
        domain: 'speech',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: 'off_input',
        sampleRate: 16000,
        durationMs: 0.25,
      },
    ]);

    const result = await runOfflineAudioToTextPipeline(
      'off_input',
      jest.fn().mockRejectedValue(new Error('stt_fail')),
      {
        segmentation: { mode: 'auto' },
        errorRecovery: 'skip',
        textSkipPlaceholder: '[skip]',
      }
    );

    expect(result.status).toBe('complete');
    expect(result.skippedSegments).toHaveLength(1);
    expect(result.segmentMappings).toHaveLength(0);
  });

  it('rejects channels other than 1 for text->audio pipeline', async () => {
    const result = await runOfflineTextToAudioPipeline('txt_in', jest.fn(), {
      segmentation: { mode: 'auto' },
      sampleRate: 16000,
      channels: 2,
    });

    expect(result.status).toBe('failed');
    expect(result.failedSegment?.error).toContain('requires channels=1 (mono)');
  });

  it('prefers materialized segment text over buffer slice offsets', async () => {
    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'txt_seg_de',
        domain: 'text',
        startOffset: 500,
        endOffset: 600,
        reason: 'length_limit',
        source: 'segmentation_engine',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text: 'Grüße aus München.',
        utf16Length: 18,
      },
    ]);

    audio.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: 'off_tmp_out',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 4,
      durationMs: 0.25,
    });

    await runOfflineTextToAudioPipeline(
      'txt_in',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
        sampleRate: 16000,
      }
    );

    expect(text.getOfflineTextBufferTextSlice).not.toHaveBeenCalled();
    expect(text.createOfflineTextBufferFromText).toHaveBeenCalledWith(
      'Grüße aus München.'
    );
  });

  it('runs offline text->audio orchestration and returns segment mappings', async () => {
    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'txt_seg_1',
        domain: 'text',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text: 'test',
        utf16Length: 4,
      },
    ]);

    audio.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: 'off_tmp_out',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 4,
      durationMs: 0.25,
    });

    const result = await runOfflineTextToAudioPipeline(
      'txt_in',
      jest.fn().mockResolvedValue(undefined),
      {
        segmentation: { mode: 'auto' },
        sampleRate: 16000,
        channels: 1,
      }
    );

    expect(result.status).toBe('complete');
    expect(result.outputBuffer?.bufferId).toBe('off_final');
    expect(result.segmentMappings).toHaveLength(1);
    expect(result.segmentMappings[0]).toMatchObject({
      textSegmentId: 'txt_seg_1',
      segmentIndex: 0,
      text: 'test',
    });
    expect(result.segmentMappings[0]?.speechSegmentId).toMatch(
      /^speech_tts_text_audio_\d+_\d+_0$/
    );
    expect(audio.appendOfflineToLiveAudioBuffer).toHaveBeenCalledWith(
      'live_acc',
      'off_tmp_out'
    );
    expect(result.timeline).toEqual([
      {
        segmentIndex: 0,
        utf16Start: 0,
        utf16End: 4,
        startSample: 0,
        numSamples: 4,
        skipped: false,
      },
    ]);
  });

  it('text->audio reports a part with nothing to speak to onNonSpeakableSegment', async () => {
    const seg = (i: number, body: string, start: number) => ({
      segmentId: `txt_seg_${i}`,
      domain: 'text',
      startOffset: start,
      endOffset: start + body.length,
      reason: 'manual_commit',
      source: 'external',
      createdAtMs: 0,
      segmentIndex: i,
      text: body,
      utf16Length: body.length,
    });
    segment.getSegments.mockResolvedValue([seg(0, 'hi', 0), seg(1, '   ', 2)]);
    audio.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: 'off_tmp_out',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 4,
      durationMs: 0.25,
    });
    const consumer = jest.fn().mockResolvedValue(undefined);
    const onNonSpeakableSegment = jest.fn(() => {
      throw new Error('a failing callback must not fail the run');
    });
    const result = await runOfflineTextToAudioPipeline('txt_in', consumer, {
      segmentation: { mode: 'auto' },
      sampleRate: 16000,
      channels: 1,
      onNonSpeakableSegment,
    });
    expect(result.status).toBe('complete');
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(onNonSpeakableSegment).toHaveBeenCalledWith(
      expect.objectContaining({ segmentIndex: 1, segmentCount: 2 })
    );
  });

  it('text->audio keeps the native error code of a failed or skipped segment', async () => {
    const seg = (i: number, body: string, start: number) => ({
      segmentId: `txt_seg_${i}`,
      domain: 'text',
      startOffset: start,
      endOffset: start + body.length,
      reason: 'manual_commit',
      source: 'external',
      createdAtMs: 0,
      segmentIndex: i,
      text: body,
      utf16Length: body.length,
    });
    segment.getSegments.mockResolvedValue([seg(0, 'hi', 0)]);
    const nativeError = Object.assign(new Error('no audio for this text'), {
      code: 'TTS_EMPTY_OUTPUT',
    });
    const failing = jest.fn().mockRejectedValue(nativeError);

    const failed = await runOfflineTextToAudioPipeline('txt_in', failing, {
      segmentation: { mode: 'auto' },
      sampleRate: 16000,
      channels: 1,
    });
    expect(failed.status).toBe('failed');
    expect(failed.failedSegment).toEqual(
      expect.objectContaining({
        error: 'no audio for this text',
        code: 'TTS_EMPTY_OUTPUT',
      })
    );

    const skipped = await runOfflineTextToAudioPipeline('txt_in', failing, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'skip',
      sampleRate: 16000,
      channels: 1,
    });
    expect(skipped.skippedSegments[0]?.code).toBe('TTS_EMPTY_OUTPUT');

    const plain = await runOfflineTextToAudioPipeline(
      'txt_in',
      jest.fn().mockRejectedValue(new Error('plain')),
      { segmentation: { mode: 'auto' }, sampleRate: 16000, channels: 1 }
    );
    expect(plain.failedSegment).not.toHaveProperty('code');
  });

  it('text->audio timeline accumulates sample offsets across segments', async () => {
    const seg = (i: number, start: number, end: number) => ({
      segmentId: `txt_seg_${i}`,
      domain: 'text',
      startOffset: start,
      endOffset: end,
      reason: 'boundary',
      source: 'external',
      createdAtMs: Date.now(),
      segmentIndex: i,
      text: 'x'.repeat(end - start),
      utf16Length: end - start,
    });
    segment.getSegments.mockResolvedValue([seg(0, 0, 10), seg(1, 10, 25)]);
    const sizes = [1600, 3200];
    let call = 0;
    audio.getPipelineAudioBufferInfo.mockImplementation(() =>
      Promise.resolve({
        bufferId: 'off_tmp_out',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: sizes[call++] ?? 0,
        durationMs: 0,
      })
    );

    const result = await runOfflineTextToAudioPipeline(
      'txt_in',
      jest.fn().mockResolvedValue(undefined),
      { segmentation: { mode: 'auto' }, sampleRate: 16000, channels: 1 }
    );

    expect(
      result.timeline.map((t) => [
        t.utf16Start,
        t.utf16End,
        t.startSample,
        t.numSamples,
      ])
    ).toEqual([
      [0, 10, 0, 1600],
      [10, 25, 1600, 3200],
    ]);
  });

  it('text->audio skip recovery inserts silence checkpoint and reports skip', async () => {
    segment.getSegments.mockResolvedValue([
      {
        segmentId: 'txt_seg_skip',
        domain: 'text',
        startOffset: 0,
        endOffset: 4,
        reason: 'manual_commit',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text: 'test',
        utf16Length: 4,
      },
    ]);

    const result = await runOfflineTextToAudioPipeline(
      'txt_in',
      jest.fn().mockRejectedValue(new Error('tts_fail')),
      {
        segmentation: { mode: 'auto' },
        errorRecovery: 'skip',
        sampleRate: 16000,
      }
    );

    expect(result.status).toBe('complete');
    expect(result.skippedSegments).toHaveLength(1);
    expect(result.segmentMappings).toHaveLength(0);
    expect(audio.appendSamplesToLiveAudioBuffer).toHaveBeenCalled();
    expect(result.timeline).toEqual([
      {
        segmentIndex: 0,
        utf16Start: 0,
        utf16End: 4,
        startSample: 0,
        numSamples: 1600,
        skipped: true,
      },
    ]);
  });

  describe('runOfflineAudioMultiOutputPipeline', () => {
    function setupDualOutputMocks() {
      audio.getPipelineAudioBufferInfo.mockImplementation((id: string) => {
        if (id === 'off_input') {
          return Promise.resolve({
            bufferId: 'off_input',
            kind: 'offlinePcmBuffer',
            state: 'immutable',
            sampleRate: 16000,
            channelCount: 1,
            numSamples: 4,
            durationMs: 0.25,
          });
        }
        return Promise.resolve({
          bufferId: id,
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: 4,
          durationMs: 0.25,
        });
      });

      segment.getSegments.mockResolvedValue([
        {
          segmentId: 'seg_1',
          domain: 'speech',
          startOffset: 0,
          endOffset: 4,
          reason: 'manual_commit',
          source: 'external',
          createdAtMs: Date.now(),
          segmentIndex: 0,
          sourceAudioBufferId: 'off_input',
          sampleRate: 16000,
          durationMs: 0.25,
        },
      ]);

      let liveAccIndex = 0;
      audio.createEmptyLiveAudioBuffer.mockImplementation(async () => {
        const bufferId = `live_acc_${liveAccIndex++}`;
        return {
          bufferId,
          info: {
            bufferId,
            kind: 'livePcmBuffer',
            state: 'recording',
            sampleRate: 16000,
            channelCount: 1,
            numSamples: 0,
            durationMs: 0,
            totalSamplesWritten: 0,
            ringEvictedSamples: 0,
            hasActiveSpool: true,
          },
          unsubscribeEvents: jest.fn(),
        };
      });

      let tempOutIndex = 0;
      audio.createEmptyOfflineAudioBuffer.mockImplementation(async () => {
        const bufferId = `off_tmp_out_${tempOutIndex++}`;
        return {
          bufferId,
          info: {
            bufferId,
            kind: 'offlinePcmBuffer',
            state: 'immutable',
            sampleRate: 16000,
            channelCount: 1,
            numSamples: 0,
            durationMs: 0,
          },
        };
      });

      let finalIndex = 0;
      audio.transferOfflineAudioBufferFromLive.mockImplementation(async () => {
        const bufferId = `off_final_${finalIndex++}`;
        return {
          bufferId,
          info: {
            bufferId,
            kind: 'offlinePcmBuffer',
            state: 'immutable',
            sampleRate: 16000,
            channelCount: 1,
            numSamples: 8,
            durationMs: 0.5,
          },
        };
      });
    }

    it('produces N output buffers and invokes consumer with N temp outs per segment', async () => {
      setupDualOutputMocks();

      const consumer = jest.fn().mockResolvedValue(undefined);
      const result = await runOfflineAudioMultiOutputPipeline(
        'off_input',
        2,
        consumer,
        { segmentation: { mode: 'auto' } }
      );

      expect(result.status).toBe('complete');
      expect(result.outputBuffer).toHaveLength(2);
      expect(consumer).toHaveBeenCalledTimes(1);
      const segOuts = consumer.mock.calls[0]?.[1] as { bufferId: string }[];
      expect(segOuts).toHaveLength(2);
      expect(audio.createEmptyLiveAudioBuffer).toHaveBeenCalledTimes(2);
      expect(
        audio.createEmptyLiveAudioBuffer.mock.calls[0]?.[0]?.retention?.path
      ).toMatch(/\/tmp\/orch_audio_\d+_\d+_acc_out0\.wav$/);
      expect(
        audio.createEmptyLiveAudioBuffer.mock.calls[1]?.[0]?.retention?.path
      ).toMatch(/\/tmp\/orch_audio_\d+_\d+_acc_out1\.wav$/);
    });

    it('rejects outputCount <= 0', async () => {
      const result = await runOfflineAudioMultiOutputPipeline(
        'off_input',
        0,
        jest.fn(),
        { segmentation: { mode: 'auto' } }
      );

      expect(result.status).toBe('failed');
      expect(result.failedSegment?.error).toContain('outputCount >= 1');
    });

    it('skip recovery appends silence to all accumulators', async () => {
      setupDualOutputMocks();

      const result = await runOfflineAudioMultiOutputPipeline(
        'off_input',
        2,
        jest.fn().mockRejectedValue(new Error('sep_fail')),
        {
          segmentation: { mode: 'auto' },
          errorRecovery: 'skip',
        }
      );

      expect(result.status).toBe('complete');
      expect(result.skippedSegments).toHaveLength(1);
      expect(audio.appendSamplesToLiveAudioBuffer).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation, segment times and segment results', () => {
    const speechSegment = (index: number, start: number, end: number) => ({
      segmentId: `seg_${index + 1}`,
      domain: 'speech',
      startOffset: start,
      endOffset: end,
      reason: 'manual_commit',
      source: 'external',
      createdAtMs: Date.now(),
      segmentIndex: index,
      sourceAudioBufferId: 'off_input',
      sampleRate: 16000,
      durationMs: ((end - start) / 16000) * 1000,
    });

    const textSegment = (index: number, segText: string) => ({
      segmentId: `tseg_${index + 1}`,
      domain: 'text',
      startOffset: index * 4,
      endOffset: index * 4 + segText.length,
      reason: 'manual_commit',
      source: 'external',
      createdAtMs: Date.now(),
      segmentIndex: index,
      text: segText,
      utf16Length: segText.length,
    });

    const setupAudioInput = () => {
      audio.getPipelineAudioBufferInfo.mockImplementation((id: string) =>
        Promise.resolve({
          bufferId: id,
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: id === 'off_input' ? 48000 : 4,
          durationMs: id === 'off_input' ? 3000 : 0.25,
        })
      );
      segment.getSegments.mockResolvedValue([
        speechSegment(0, 0, 16000),
        speechSegment(1, 16000, 40000),
        speechSegment(2, 40000, 48000),
      ]);
    };

    const expectCancelled = async (promise: Promise<unknown>) => {
      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ORCHESTRATION_CANCELLED',
      });
    };

    it('rejects without native work when the signal is aborted before start', async () => {
      setupAudioInput();
      const controller = new AbortController();
      controller.abort();
      const consumer = jest.fn().mockResolvedValue(undefined);

      await expectCancelled(
        runOfflineAudioPipeline('off_input', consumer, {
          segmentation: { mode: 'auto' },
          signal: controller.signal,
        })
      );

      expect(consumer).not.toHaveBeenCalled();
      expect(audio.getPipelineAudioBufferInfo).not.toHaveBeenCalled();
      expect(audio.createEmptyLiveAudioBuffer).not.toHaveBeenCalled();
    });

    it('rejects before the single call when segmentation is off', async () => {
      setupAudioInput();
      const controller = new AbortController();
      controller.abort();
      const consumer = jest.fn().mockResolvedValue(undefined);

      await expectCancelled(
        runOfflineAudioToTextPipeline('off_input', consumer, {
          signal: controller.signal,
        })
      );
      expect(consumer).not.toHaveBeenCalled();
    });

    it('stops between segments, releases temporaries and the accumulator', async () => {
      setupAudioInput();
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        if (consumer.mock.calls.length === 1) controller.abort();
      });

      await expectCancelled(
        runOfflineAudioPipeline('off_input', consumer, {
          segmentation: { mode: 'auto' },
          signal: controller.signal,
        })
      );

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'off_tmp_in_4'
      );
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'off_tmp_out'
      );
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
      expect(audio.transferOfflineAudioBufferFromLive).not.toHaveBeenCalled();
    });

    it('releases every accumulator of a multi-output run on abort', async () => {
      setupAudioInput();
      let n = 0;
      audio.createEmptyLiveAudioBuffer.mockImplementation(async () => {
        n += 1;
        return { bufferId: `live_acc_${n}`, unsubscribeEvents: jest.fn() };
      });
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        controller.abort();
      });

      await expectCancelled(
        runOfflineAudioMultiOutputPipeline('off_input', 2, consumer, {
          segmentation: { mode: 'auto' },
          signal: controller.signal,
        })
      );

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'live_acc_1'
      );
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'live_acc_2'
      );
    });

    it('stops before a retry instead of retrying', async () => {
      setupAudioInput();
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error('transient');
      });

      await expectCancelled(
        runOfflineAudioPipeline('off_input', consumer, {
          segmentation: { mode: 'auto' },
          errorRecovery: 'retry',
          maxRetriesPerSegment: 3,
          signal: controller.signal,
        })
      );

      expect(consumer).toHaveBeenCalledTimes(1);
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'off_tmp_in_4'
      );
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
    });

    it('stops after the current segment fails while aborted', async () => {
      setupAudioInput();
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error('boom');
      });

      await expectCancelled(
        runOfflineAudioToTextPipeline('off_input', consumer, {
          segmentation: { mode: 'auto' },
          errorRecovery: 'skip',
          signal: controller.signal,
        })
      );
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(text.releasePipelineTextBuffer).toHaveBeenCalledWith('txt_empty');
    });

    it('finishes the run when the signal aborts during the last segment', async () => {
      setupAudioInput();
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        if (consumer.mock.calls.length === 3) controller.abort();
      });

      const result = await runOfflineAudioPipeline('off_input', consumer, {
        segmentation: { mode: 'auto' },
        signal: controller.signal,
      });

      expect(result.status).toBe('complete');
      expect(consumer).toHaveBeenCalledTimes(3);
    });

    it('stops text pipelines between segments', async () => {
      segment.getSegments.mockResolvedValue([
        textSegment(0, 'one.'),
        textSegment(1, 'two.'),
      ]);
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        controller.abort();
      });

      await expectCancelled(
        runOfflineTextPipeline('txt_in', consumer, {
          segmentation: { mode: 'auto' },
          signal: controller.signal,
        })
      );
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(text.releasePipelineTextBuffer).toHaveBeenCalled();
      expect(text.createOfflineTextBufferFromText).toHaveBeenCalledTimes(1);
    });

    it('stops text-to-audio between segments and releases the accumulator', async () => {
      segment.getSegments.mockResolvedValue([
        textSegment(0, 'one.'),
        textSegment(1, 'two.'),
      ]);
      audio.getPipelineAudioBufferInfo.mockResolvedValue({
        bufferId: 'off_tmp_out',
        kind: 'offlinePcmBuffer',
        state: 'immutable',
        sampleRate: 16000,
        channelCount: 1,
        numSamples: 4,
        durationMs: 0.25,
      });
      const controller = new AbortController();
      const consumer = jest.fn().mockImplementation(async () => {
        controller.abort();
      });

      await expectCancelled(
        runOfflineTextToAudioPipeline('txt_in', consumer, {
          segmentation: { mode: 'auto' },
          sampleRate: 16000,
          signal: controller.signal,
        })
      );
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith(
        'off_tmp_out'
      );
      expect(audio.releasePipelineAudioBuffer).toHaveBeenCalledWith('live_acc');
      expect(audio.transferOfflineAudioBufferFromLive).not.toHaveBeenCalled();
    });

    it('reports segment start and end in ms for audio input', async () => {
      setupAudioInput();
      const onProgress = jest.fn();

      await runOfflineAudioPipeline(
        'off_input',
        jest.fn().mockResolvedValue(undefined),
        { segmentation: { mode: 'auto' }, onProgress }
      );

      expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
        expect.objectContaining({
          currentSegment: 0,
          currentSegmentStartMs: 0,
          currentSegmentEndMs: 1000,
        }),
        expect.objectContaining({
          currentSegment: 1,
          currentSegmentStartMs: 1000,
          currentSegmentEndMs: 2500,
        }),
        expect.objectContaining({
          currentSegment: 2,
          currentSegmentStartMs: 2500,
          currentSegmentEndMs: 3000,
        }),
      ]);
    });

    it('reports segment times on audio->text progress, also on retries', async () => {
      setupAudioInput();
      segment.getSegments.mockResolvedValue([speechSegment(0, 8000, 24000)]);
      const onProgress = jest.fn();
      const consumer = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined);

      await runOfflineAudioToTextPipeline('off_input', consumer, {
        segmentation: { mode: 'auto' },
        errorRecovery: 'retry',
        maxRetriesPerSegment: 1,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      for (const [p] of onProgress.mock.calls) {
        expect(p).toMatchObject({
          currentSegmentStartMs: 500,
          currentSegmentEndMs: 1500,
        });
      }
    });

    it('omits segment times for text input', async () => {
      segment.getSegments.mockResolvedValue([textSegment(0, 'one.')]);
      const onProgress = jest.fn();

      await runOfflineTextPipeline(
        'txt_in',
        jest.fn().mockResolvedValue(undefined),
        { segmentation: { mode: 'auto' }, onProgress }
      );

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress.mock.calls[0]![0]).not.toHaveProperty(
        'currentSegmentStartMs'
      );
    });

    it('calls audio->text onSegment in order with text and times', async () => {
      setupAudioInput();
      const texts = ['one ', 'two ', 'three'];
      let call = 0;
      text.getOfflineTextBufferTextSlice.mockImplementation(async () => {
        const value = texts[call] ?? '';
        call += 1;
        return value;
      });
      const onSegment = jest.fn();

      const result = await runOfflineAudioToTextPipeline(
        'off_input',
        jest.fn().mockResolvedValue(undefined),
        { segmentation: { mode: 'auto' }, onSegment }
      );

      expect(result.status).toBe('complete');
      expect(onSegment.mock.calls.map(([e]) => e)).toEqual([
        {
          segmentIndex: 0,
          segmentCount: 3,
          startMs: 0,
          endMs: 1000,
          durationMs: 1000,
          text: 'one ',
          speechSegmentId: 'seg_1',
          textSegmentId: result.segmentMappings[0]!.textSegmentId,
        },
        expect.objectContaining({
          segmentIndex: 1,
          startMs: 1000,
          endMs: 2500,
          text: 'two ',
          speechSegmentId: 'seg_2',
        }),
        expect.objectContaining({
          segmentIndex: 2,
          startMs: 2500,
          endMs: 3000,
          text: 'three',
          speechSegmentId: 'seg_3',
        }),
      ]);
    });

    it('does not call onSegment for skipped segments', async () => {
      setupAudioInput();
      const consumer = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);
      const onSegment = jest.fn();

      const result = await runOfflineAudioToTextPipeline(
        'off_input',
        consumer,
        {
          segmentation: { mode: 'auto' },
          errorRecovery: 'skip',
          onSegment,
        }
      );

      expect(result.skippedSegments).toHaveLength(1);
      expect(onSegment.mock.calls.map(([e]) => e.segmentIndex)).toEqual([0, 2]);
    });

    it('a throwing onSegment does not fail the run', async () => {
      setupAudioInput();
      const onSegment = jest.fn(() => {
        throw new Error('callback failed');
      });
      const consumer = jest.fn().mockResolvedValue(undefined);

      const result = await runOfflineAudioToTextPipeline(
        'off_input',
        consumer,
        {
          segmentation: { mode: 'auto' },
          onSegment,
        }
      );

      expect(result.status).toBe('complete');
      expect(result.completedSegments).toBe(3);
      expect(result.skippedSegments).toHaveLength(0);
      expect(onSegment).toHaveBeenCalledTimes(3);
      expect(consumer).toHaveBeenCalledTimes(3);
    });
  });

  describe('audio output on the input timeline', () => {
    const seg = (i: number, start: number, end: number) => ({
      segmentId: `seg_${i}`,
      domain: 'speech',
      startOffset: start,
      endOffset: end,
      reason: 'manual_commit',
      source: 'external',
      createdAtMs: 0,
      segmentIndex: i,
      sourceAudioBufferId: 'off_input',
      sampleRate: 16000,
      durationMs: (end - start) / 16,
    });

    /** Input of 300 frames in 3 parts; every part's output has `outLen` samples. */
    function setup(outLen: (inLen: number) => number) {
      const lastIn: number[] = [];
      audio.getPipelineAudioBufferInfo.mockImplementation((id: string) =>
        Promise.resolve({
          bufferId: id,
          kind: 'offlinePcmBuffer',
          state: 'immutable',
          sampleRate: 16000,
          channelCount: 1,
          numSamples: id === 'off_input' ? 300 : outLen(lastIn[0] ?? 0),
          durationMs: 0,
        })
      );
      audio.getOfflineAudioBufferSamplesSlice.mockImplementation(
        (_id: string, _start: number, count: number) => new Float32Array(count)
      );
      segment.getSegments.mockResolvedValue([
        seg(0, 0, 100),
        seg(1, 100, 200),
        seg(2, 200, 300),
      ]);
      const consumer = jest.fn(
        async (input: { info: { numSamples: number } }) => {
          lastIn[0] = input.info.numSamples;
        }
      );
      directFrames = 0;
      audio.appendOfflineToLiveAudioBuffer.mockImplementation(async () => {
        directFrames += outLen(lastIn[0] ?? 0);
      });
      return consumer;
    }

    let directFrames = 0;

    /** Frames that reached the accumulator, at 16 kHz. */
    function appendedFrames(): number {
      let n = directFrames;
      for (const call of audio.appendSamplesToLiveAudioBuffer.mock.calls) {
        n += (call[1] as Float32Array).length;
      }
      return n;
    }

    it('pads a part whose output is a little short', async () => {
      const consumer = setup((inLen) => inLen - 7);
      await runOfflineAudioPipeline('off_input', consumer as never, {
        segmentation: { mode: 'auto' },
      });
      expect(appendedFrames()).toBe(300);
    });

    it('trims a part whose output is a little long', async () => {
      const consumer = setup((inLen) => inLen + 5);
      await runOfflineAudioPipeline('off_input', consumer as never, {
        segmentation: { mode: 'auto' },
      });
      expect(appendedFrames()).toBe(300);
    });

    it('gives the overlap as context before a part and cuts it again', async () => {
      const consumer = setup((inLen) => inLen);
      await runOfflineAudioPipeline('off_input', consumer as never, {
        segmentation: { mode: 'auto' },
        overlapSamples: 20,
      });
      expect(audio.getOfflineAudioBufferSamplesSlice).toHaveBeenCalledWith(
        'off_input',
        80,
        120
      );
      expect(appendedFrames()).toBe(300);
    });
  });
});
