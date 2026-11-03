jest.mock('react-native', () => {
  const mockNative = {
    createLiveSegmentBuffer: jest.fn(),
    getLiveSegmentBufferSegments: jest.fn(),
    getLiveSegmentBufferSegmentCount: jest.fn(),
    releasePipelineSegmentBuffer: jest.fn(),
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
          listeners.get(eventName)?.delete(cb);
        },
      };
    }
  }

  return {
    NativeEventEmitter: MockNativeEventEmitter,
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    NativeModules: {
      SherpaOnnx: mockNative,
    },
    __mockNative: mockNative,
    __emitEvent: (eventName: string, payload: unknown): void => {
      const set = listeners.get(eventName);
      if (!set) return;
      for (const cb of set) cb(payload);
    },
  };
});

import {
  createLiveSegmentBuffer,
  readLiveSegment,
  subscribeLiveSegmentBufferEvents,
} from '../index';

describe('segmentbuffer appended event wiring', () => {
  const liveBufferId = 'seg_live_11111111-1111-1111-1111-111111111111';
  const reactNativeMock = jest.requireMock('react-native') as any;
  const mockNative = reactNativeMock.__mockNative;
  const emitEvent = reactNativeMock.__emitEvent as (
    eventName: string,
    payload: unknown
  ) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.createLiveSegmentBuffer.mockResolvedValue({
      bufferId: liveBufferId,
      state: 'recording',
      segmentCount: 0,
      spoolMode: 'on',
      spoolEnabled: true,
      spoolReady: false,
      spoolBytes: 0,
    });
    mockNative.getLiveSegmentBufferSegments.mockResolvedValue({
      segments: [
        {
          id: 'seg_0',
          kind: 'speech',
          sourceAudioBufferId: 'live_audio_1',
          startSample: 0,
          endSample: 16000,
          sampleRate: 16000,
          durationMs: 1000,
          payload: { source: 'vad' },
        },
      ],
    });
    mockNative.getLiveSegmentBufferSegmentCount.mockResolvedValue(1);
    mockNative.releasePipelineSegmentBuffer.mockResolvedValue(null);
  });

  it('dispatches notify-only onSegmentAppended without payload', async () => {
    const onSegmentAppended = jest.fn();
    const ref = await createLiveSegmentBuffer({ onSegmentAppended });

    emitEvent('pipelineLiveSegmentAppended', {
      segmentBufferId: liveBufferId,
      segmentId: 'seg_0',
      kind: 'speech',
      segmentIndex: 0,
      totalSegments: 1,
      sourceAudioBufferId: 'live_audio_1',
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
      payload: { source: 'vad', shouldBeIgnored: true },
    });

    expect(onSegmentAppended).toHaveBeenCalledTimes(1);
    expect(onSegmentAppended.mock.calls[0][0]).toEqual({
      segmentBufferId: liveBufferId,
      segmentId: 'seg_0',
      kind: 'speech',
      segmentIndex: 0,
      totalSegments: 1,
      sourceAudioBufferId: 'live_audio_1',
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
    });
    expect(onSegmentAppended.mock.calls[0][0].payload).toBeUndefined();

    ref.unsubscribeEvents();
  });

  it('dedupes repeated segmentIndex notifies', async () => {
    const onSegmentAppended = jest.fn();
    const ref = await createLiveSegmentBuffer({ onSegmentAppended });

    const payload = {
      segmentBufferId: liveBufferId,
      segmentId: 'seg_0',
      kind: 'speech',
      segmentIndex: 1,
      totalSegments: 2,
      sourceAudioBufferId: 'live_audio_1',
      startSample: 0,
      endSample: 100,
      sampleRate: 16000,
      durationMs: 10,
    };
    emitEvent('pipelineLiveSegmentAppended', payload);
    emitEvent('pipelineLiveSegmentAppended', payload);

    expect(onSegmentAppended).toHaveBeenCalledTimes(1);
    ref.unsubscribeEvents();
  });

  it('readLiveSegment pulls via getLiveSegmentBufferSegments', async () => {
    const meta = await readLiveSegment({
      segmentBufferId: liveBufferId,
      segmentIndex: 0,
      totalSegments: 1,
      kind: 'speech',
      segmentId: 'seg_0',
      sourceAudioBufferId: 'live_audio_1',
      startSample: 0,
      endSample: 16000,
      sampleRate: 16000,
      durationMs: 1000,
    });

    expect(mockNative.getLiveSegmentBufferSegments).toHaveBeenCalledWith(
      liveBufferId,
      0,
      1
    );
    expect(meta).toMatchObject({
      id: 'seg_0',
      kind: 'speech',
      payload: { source: 'vad' },
    });
  });

  it('subscribeLiveSegmentBufferEvents works after create', async () => {
    const onSegmentAppended = jest.fn();
    const ref = await createLiveSegmentBuffer();
    const unsub = subscribeLiveSegmentBufferEvents(ref.bufferId, {
      onSegmentAppended,
    });

    emitEvent('pipelineLiveSegmentAppended', {
      segmentBufferId: liveBufferId,
      segmentId: 'seg_1',
      kind: 'diarization',
      segmentIndex: 2,
      totalSegments: 3,
      sourceAudioBufferId: 'live_audio_1',
      startSample: 10,
      endSample: 20,
      sampleRate: 16000,
      durationMs: 1,
    });

    expect(onSegmentAppended).toHaveBeenCalledTimes(1);
    expect(onSegmentAppended.mock.calls[0][0].kind).toBe('diarization');

    unsub();
    emitEvent('pipelineLiveSegmentAppended', {
      segmentBufferId: liveBufferId,
      segmentId: 'seg_2',
      kind: 'speech',
      segmentIndex: 3,
      totalSegments: 4,
      sourceAudioBufferId: 'live_audio_1',
      startSample: 20,
      endSample: 30,
      sampleRate: 16000,
      durationMs: 1,
    });
    expect(onSegmentAppended).toHaveBeenCalledTimes(1);
  });
});
