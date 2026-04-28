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
    __mockNative: mockNative,
    __emitEvent: emitEvent,
    __resetEvents: resetEvents,
  };
});

import { createEmptyLiveAudioBuffer, finalizeLiveAudioBuffer } from '../index';

describe('audiobuffer segment event wiring', () => {
  const liveBufferId = 'live_11111111-1111-1111-1111-111111111111';
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
      state: 'recording',
      sampleRate: 16000,
      channelCount: 1,
      numSamples: 32000,
      durationMs: 2000,
      totalSamplesWritten: 32000,
      ringEvictedSamples: 0,
      hasActiveSpool: true,
    });
    mockNative.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: 'seg_live_11111111-1111-1111-1111-111111111111',
    });
    mockNative.appendLiveSegment.mockResolvedValue({
      segmentId: 'seg_1',
      segmentIndex: 0,
    });
    mockNative.getLiveSegmentBufferSegmentCount.mockResolvedValue(1);
    mockNative.finalizeLiveAudioBuffer.mockResolvedValue(null);
    mockNative.releasePipelineAudioBuffer.mockResolvedValue(null);
  });

  it('dispatches onSegment callback from native segment appended events', async () => {
    const onSegment = jest.fn();

    const ref = await createEmptyLiveAudioBuffer({
      sampleRate: 16000,
      channelCount: 1,
      segmentation: { mode: 'manual' },
      onSegment,
    });

    emitEvent('pipelineLiveSegmentAppended', {
      liveBufferId: 'seg_live_11111111-1111-1111-1111-111111111111',
      sourceAudioBufferId: liveBufferId,
      segmentId: 'seg_1',
      segmentIndex: 0,
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
    });

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0][0]).toMatchObject({
      bufferId: liveBufferId,
      totalSegments: 1,
      segment: {
        domain: 'speech',
        segmentId: 'seg_1',
        startOffset: 0,
        endOffset: 16000,
      },
    });

    ref.unsubscribeEvents();
  });

  it('auto-commits pending audio frames on finalize when segmentation is active', async () => {
    const ref = await createEmptyLiveAudioBuffer({
      sampleRate: 16000,
      channelCount: 1,
      segmentation: { mode: 'manual' },
    });

    await finalizeLiveAudioBuffer(ref.bufferId);

    expect(mockNative.createLiveSegmentBuffer).toHaveBeenCalled();
    expect(mockNative.appendLiveSegment).toHaveBeenCalledWith(
      'seg_live_11111111-1111-1111-1111-111111111111',
      'speech',
      liveBufferId,
      0,
      32000,
      16000,
      2000,
      undefined,
      undefined
    );
    expect(mockNative.finalizeLiveAudioBuffer).toHaveBeenCalledWith(
      liveBufferId
    );
  });
});
