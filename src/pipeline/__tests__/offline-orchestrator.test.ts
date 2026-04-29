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
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
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
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
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

  it('cancels with strategy=abort without producing output buffer', async () => {
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

    const abortController = new AbortController();
    const consumer = jest.fn().mockImplementation(async () => {
      abortController.abort();
    });

    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'abort',
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.outputBuffer).toBeUndefined();
  });

  it('cancels with strategy=skip and returns partial output buffer', async () => {
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

    const abortController = new AbortController();
    const consumer = jest.fn().mockImplementation(async () => {
      abortController.abort();
    });

    const result = await runOfflineAudioPipeline('off_input', consumer, {
      segmentation: { mode: 'auto' },
      errorRecovery: 'skip',
      abortSignal: abortController.signal,
    });

    expect(result.status).toBe('cancelled');
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
          hasLang: false,
          hasEmotion: false,
          hasEvent: false,
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
        hasLang: false,
        hasEmotion: false,
        hasEvent: false,
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
});
