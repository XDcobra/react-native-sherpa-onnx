jest.mock('react-native', () => {
  const mockNative = {
    createEmptyLiveAudioBuffer: jest.fn(),
    getPipelineAudioBufferInfo: jest.fn(),
    createLiveSegmentBuffer: jest.fn(),
    appendLiveSegment: jest.fn(),
    getLiveSegmentBufferSegmentCount: jest.fn(),
    finalizeLiveAudioBuffer: jest.fn(),
    releasePipelineAudioBuffer: jest.fn(),
  };

  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  class MockNativeEventEmitter {
    addListener(
      eventName: string,
      cb: (payload: unknown) => void
    ): { remove: () => void } {
      const set = listeners.get(eventName) ?? new Set();
      set.add(cb);
      listeners.set(eventName, set);
      return {
        remove: () => {
          const current = listeners.get(eventName);
          current?.delete(cb);
        },
      };
    }
  }

  const emitEvent = (eventName: string, payload: unknown): void => {
    const set = listeners.get(eventName);
    if (!set) return;
    for (const cb of set) {
      cb(payload);
    }
  };

  const resetEvents = (): void => {
    listeners.clear();
  };

  return {
    NativeEventEmitter: MockNativeEventEmitter,
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    NativeModules: {
      SherpaOnnx: mockNative,
    },
    __mockNative: mockNative,
    __emitEvent: emitEvent,
    __resetEvents: resetEvents,
  };
});

import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  liveAudioNotifyToSpeechSegment,
} from '../index';

describe('audiobuffer segment event wiring', () => {
  const liveBufferId = 'live_11111111-1111-1111-1111-111111111111';
  const segBufferId = 'seg_live_11111111-1111-1111-1111-111111111111';
  const reactNativeMock = jest.requireMock('react-native') as any;
  const mockNative = reactNativeMock.__mockNative;
  const emitEvent = reactNativeMock.__emitEvent as (
    eventName: string,
    payload: unknown
  ) => void;
  const resetEvents = reactNativeMock.__resetEvents as () => void;

  beforeEach(() => {
    jest.clearAllMocks();
    resetEvents();

    mockNative.createEmptyLiveAudioBuffer.mockResolvedValue({
      bufferId: liveBufferId,
      kind: 'livePcmBuffer',
      state: 'recording',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 0,
      durationMs: 0,
      totalSamplesWritten: 0,
      ringEvictedSamples: 0,
      hasActiveSpool: true,
    });
    mockNative.getPipelineAudioBufferInfo.mockResolvedValue({
      bufferId: liveBufferId,
      kind: 'livePcmBuffer',
      state: 'finished',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 32000,
      durationMs: 2000,
      totalSamplesWritten: 32000,
      ringEvictedSamples: 0,
      hasActiveSpool: true,
    });
    mockNative.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: segBufferId,
    });
    mockNative.appendLiveSegment.mockResolvedValue({
      segmentId: 'seg_1',
      segmentIndex: 0,
    });
    mockNative.getLiveSegmentBufferSegmentCount.mockResolvedValue(1);
    mockNative.finalizeLiveAudioBuffer.mockResolvedValue(null);
    mockNative.releasePipelineAudioBuffer.mockResolvedValue(null);
  });

  it('dispatches notify-only onSegment without embedded SpeechSegment', async () => {
    const onSegment = jest.fn();

    const ref = await createEmptyLiveAudioBuffer({
      sampleRate: 16000,
      channelCount: 1,
      segmentation: { mode: 'manual' },
      onSegment,
    });

    emitEvent('pipelineLiveSegmentAppended', {
      segmentBufferId: segBufferId,
      sourceAudioBufferId: liveBufferId,
      segmentId: 'seg_1',
      segmentIndex: 0,
      totalSegments: 1,
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 123456789,
      payload: { source: 'vad', shouldBeIgnored: true },
    });

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0][0]).toEqual({
      bufferId: liveBufferId,
      segmentBufferId: segBufferId,
      segmentId: 'seg_1',
      segmentIndex: 0,
      totalSegments: 1,
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 123456789,
    });
    expect(onSegment.mock.calls[0][0].segment).toBeUndefined();
    expect(onSegment.mock.calls[0][0].payload).toBeUndefined();

    ref.unsubscribeEvents();
  });

  it('liveAudioNotifyToSpeechSegment maps notify scalars to SpeechSegment', () => {
    const speech = liveAudioNotifyToSpeechSegment({
      bufferId: liveBufferId,
      segmentBufferId: segBufferId,
      segmentId: 'seg_1',
      segmentIndex: 0,
      totalSegments: 1,
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 123456789,
      confidence: 0.9,
    });

    expect(speech).toEqual({
      segmentId: 'seg_1',
      domain: 'speech',
      startOffset: 0,
      endOffset: 16000,
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 123456789,
      segmentIndex: 0,
      sourceAudioBufferId: liveBufferId,
      sampleRate: 16000,
      durationMs: 1000,
      confidence: 0.9,
    });
  });

  it('auto-commits pending audio frames on finalize when segmentation is active', async () => {
    const ref = await createEmptyLiveAudioBuffer({
      sampleRate: 16000,
      channelCount: 1,
      segmentation: { mode: 'manual' },
    });

    const finished = await finalizeLiveAudioBuffer(ref.bufferId);

    expect(finished.info.state).toBe('finished');
    expect(finished.info.durationMs).toBe(2000);
    expect(mockNative.createLiveSegmentBuffer).toHaveBeenCalled();
    expect(mockNative.appendLiveSegment).toHaveBeenCalledWith(
      segBufferId,
      'speech',
      liveBufferId,
      0,
      32000,
      16000,
      2000,
      undefined,
      expect.objectContaining({
        source: 'manual',
        __annotationReason: 'finalize',
        __annotationSource: 'manual',
        __annotationCreatedAtMs: expect.any(Number),
      })
    );
    expect(mockNative.finalizeLiveAudioBuffer).toHaveBeenCalledWith(
      liveBufferId
    );
  });
});
