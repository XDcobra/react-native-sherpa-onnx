jest.mock('react-native', () => {
  const mockNative = {
    createLiveTextBuffer: jest.fn(),
    appendLiveTextSegment: jest.fn(),
    getLiveTextBufferSegments: jest.fn(),
    getLiveTextBufferPartialSlice: jest.fn(),
    setLiveTextBufferPartial: jest.fn(),
    finalizeLiveTextBuffer: jest.fn(),
    releasePipelineTextBuffer: jest.fn(),
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

import {
  appendLiveTextSegment,
  createLiveTextBuffer,
  finalizeLiveTextBuffer,
  subscribeLiveTextBufferEvents,
} from '../index';

describe('textbuffer segment event wiring', () => {
  const liveBufferId = 'txt_live_11111111-1111-1111-1111-111111111111';
  const reactNativeMock = jest.requireMock('react-native') as any;
  const mockNative = reactNativeMock.__mockNative;
  const emitEvent = reactNativeMock.__emitEvent as (
    eventName: string,
    payload: unknown
  ) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.createLiveTextBuffer.mockResolvedValue({
      bufferId: liveBufferId,
      state: 'recording',
      totalCharsWritten: 0,
      revision: 0,
      segmentCount: 0,
      spoolMode: 'on',
      spoolEnabled: true,
      spoolReady: false,
      spoolBytes: 0,
    });
    mockNative.appendLiveTextSegment.mockResolvedValue({ segmentIndex: 0 });
    mockNative.getLiveTextBufferSegments.mockResolvedValue({
      segments: [
        {
          text: 'hello',
          source: 'append',
          segmentIndex: 0,
          meta: {
            __segmentReason: 'manual_commit',
            __segmentSource: 'manual',
            __segmentCreatedAtMs: 123,
          },
        },
      ],
    });
    mockNative.getLiveTextBufferPartialSlice.mockResolvedValue('');
    mockNative.setLiveTextBufferPartial.mockResolvedValue(null);
    mockNative.finalizeLiveTextBuffer.mockResolvedValue(null);
    mockNative.releasePipelineTextBuffer.mockResolvedValue(null);
  });

  it('dispatches onSegment callback after text segment commit', async () => {
    const onSegment = jest.fn();
    const ref = await createLiveTextBuffer({ onSegment });

    await appendLiveTextSegment(ref.bufferId, 'hello');

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0][0]).toMatchObject({
      bufferId: liveBufferId,
      totalSegments: 1,
      segment: {
        domain: 'text',
        text: 'hello',
        segmentIndex: 0,
      },
    });

    ref.unsubscribeEvents();
  });

  it('auto-commits remaining partial on finalize when segmentation is active', async () => {
    const ref = await createLiveTextBuffer();

    mockNative.getLiveTextBufferPartialSlice.mockResolvedValue('tail partial');
    mockNative.appendLiveTextSegment.mockResolvedValue({ segmentIndex: 1 });

    await finalizeLiveTextBuffer(ref.bufferId);

    expect(mockNative.appendLiveTextSegment).toHaveBeenCalledWith(
      liveBufferId,
      'tail partial',
      undefined,
      undefined,
      expect.objectContaining({
        __segmentReason: 'finalize',
        __segmentSource: 'manual',
      })
    );
    expect(mockNative.setLiveTextBufferPartial).toHaveBeenCalledWith(
      liveBufferId,
      ''
    );
    expect(mockNative.finalizeLiveTextBuffer).toHaveBeenCalledWith(
      liveBufferId
    );
  });

  it('dispatches onSegment callback from native worker segment events', async () => {
    const onSegment = jest.fn();
    const ref = await createLiveTextBuffer({ onSegment });

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId,
      text: 'worker commit',
      textTruncated: true,
      source: 'stt_stream',
      segmentIndex: 2,
      totalSegments: 3,
      tokens: ['worker', 'commit'],
      timestamps: [0, 1],
      meta: {
        __segmentCreatedAtMs: 777,
      },
    });

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0][0]).toMatchObject({
      bufferId: liveBufferId,
      totalSegments: 3,
      segment: {
        domain: 'text',
        text: 'worker commit',
        textTruncated: true,
        reason: 'endpoint',
        segmentIndex: 2,
      },
    });

    ref.unsubscribeEvents();
  });

  it('subscribeLiveTextBufferEvents works after creation without initial callbacks', async () => {
    const uniqueBufferId = 'txt_live_22222222-2222-2222-2222-222222222222';
    mockNative.createLiveTextBuffer.mockResolvedValueOnce({
      bufferId: uniqueBufferId,
      state: 'recording',
    });
    const onSegment = jest.fn();
    const ref = await createLiveTextBuffer(); // No initial callbacks

    const unsubscribe = subscribeLiveTextBufferEvents(ref.bufferId, {
      onSegment,
    });

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'hello via subscribe',
      segmentIndex: 1,
      totalSegments: 1,
    });

    expect(onSegment).toHaveBeenCalledTimes(1);

    unsubscribe();

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'ignored after unsubscribe',
      segmentIndex: 2,
      totalSegments: 2,
    });

    expect(onSegment).toHaveBeenCalledTimes(1); // Still 1
  });

  it('supports multiple subscriptions and targeted unsubscriptions', async () => {
    const uniqueBufferId = 'txt_live_33333333-3333-3333-3333-333333333333';
    mockNative.createLiveTextBuffer.mockResolvedValueOnce({
      bufferId: uniqueBufferId,
      state: 'recording',
    });
    const cb1 = jest.fn();
    const cb2 = jest.fn();

    const ref = await createLiveTextBuffer();

    const unsub1 = subscribeLiveTextBufferEvents(ref.bufferId, {
      onSegment: cb1,
    });
    const unsub2 = subscribeLiveTextBufferEvents(ref.bufferId, {
      onSegment: cb2,
    });

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'event 1',
      segmentIndex: 1,
      totalSegments: 1,
    });

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub1(); // Only cb1 should stop

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'event 2',
      segmentIndex: 2,
      totalSegments: 2,
    });

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(2);

    unsub2();
  });

  it('combines create callbacks and subscribe callbacks cleanly', async () => {
    const uniqueBufferId = 'txt_live_44444444-4444-4444-4444-444444444444';
    mockNative.createLiveTextBuffer.mockResolvedValueOnce({
      bufferId: uniqueBufferId,
      state: 'recording',
    });
    const createCb = jest.fn();
    const subCb = jest.fn();

    const ref = await createLiveTextBuffer({ onSegment: createCb });
    const unsub = subscribeLiveTextBufferEvents(ref.bufferId, {
      onSegment: subCb,
    });

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'event 1',
      segmentIndex: 1,
      totalSegments: 1,
    });

    expect(createCb).toHaveBeenCalledTimes(1);
    expect(subCb).toHaveBeenCalledTimes(1);

    ref.unsubscribeEvents(); // Only removes createCb

    emitEvent('pipelineLiveTextSegmentAppended', {
      liveBufferId: uniqueBufferId,
      text: 'event 2',
      segmentIndex: 2,
      totalSegments: 2,
    });

    expect(createCb).toHaveBeenCalledTimes(1);
    expect(subCb).toHaveBeenCalledTimes(2);

    unsub();
  });
});
