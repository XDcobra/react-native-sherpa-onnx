import { createEngine } from '../engine';
import type { StreamingTtsEngine } from '../../streamingTypes';
import type {
  TtsStreamHandlers,
  TtsStreamController,
  TtsStreamOptions,
  TtsGenerationOptions,
} from '../../types';
import type {
  SessionEvent,
  SegmentEvent,
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamHandlers,
  IncrementalStreamController,
} from '../types';

// ---------------------------------------------------------------------------
// Mock StreamingTtsEngine
// ---------------------------------------------------------------------------

type PendingStream = {
  text: string;
  handlers: TtsStreamHandlers;
  controller: TtsStreamController;
};

function createMockStreamingEngine(): StreamingTtsEngine & {
  pendingStreams: PendingStream[];
  completeNext: (cancelled?: boolean) => void;
  failNext: (message: string) => void;
} {
  const pendingStreams: PendingStream[] = [];

  const engine: StreamingTtsEngine = {
    instanceId: 'mock_streaming_1',

    async generateSpeechStream(
      text: string,
      _opts: TtsGenerationOptions | undefined,
      handlers: TtsStreamHandlers,
      _streamOptions?: TtsStreamOptions
    ): Promise<TtsStreamController> {
      const controller: TtsStreamController = {
        async cancel() {
          handlers.onEnd?.({ cancelled: true });
        },
        unsubscribe() {},
        player: null,
      };
      pendingStreams.push({ text, handlers, controller });
      return controller;
    },

    async generateSpeechStreamToFile() {
      throw new Error('Not implemented in mock');
    },

    async cancelSpeechStream() {},
    async getModelInfo() {
      return { sampleRate: 22050, numSpeakers: 1 };
    },
    async getSampleRate() {
      return 22050;
    },
    async getNumSpeakers() {
      return 1;
    },
    async destroy() {},
  };

  return Object.assign(engine, {
    pendingStreams,
    completeNext(cancelled = false) {
      const stream = pendingStreams.shift();
      if (!stream) throw new Error('No pending stream to complete');
      stream.handlers.onEnd?.({ cancelled });
    },
    failNext(message: string) {
      const stream = pendingStreams.shift();
      if (!stream) throw new Error('No pending stream to fail');
      stream.handlers.onError?.({ message });
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFactoryOptions(
  overrides?: Partial<Omit<IncrementalStreamingTtsFactoryOptions, 'source'>>
): Omit<IncrementalStreamingTtsFactoryOptions, 'source'> {
  return {
    segmentation: {
      maxWaitMs: 0,
      debounceMs: 0,
      minCharsPerSegment: 5,
      ...(overrides?.segmentation ?? {}),
    },
    queue: overrides?.queue,
  };
}

function createHandlers(): IncrementalStreamHandlers & {
  sessionEvents: SessionEvent[];
  segmentEvents: SegmentEvent[];
  ended: boolean;
  endCancelled: boolean | null;
} {
  const sessionEvents: SessionEvent[] = [];
  const segmentEvents: SegmentEvent[] = [];
  let ended = false;
  let endCancelled: boolean | null = null;

  const handlers = {
    onSessionEvent: (e: SessionEvent) => sessionEvents.push(e),
    onSegmentEvent: (e: SegmentEvent) => segmentEvents.push(e),
    onEnd: (event: { cancelled: boolean }) => {
      ended = true;
      endCancelled = event.cancelled;
    },
    sessionEvents,
    segmentEvents,
    get ended() {
      return ended;
    },
    get endCancelled() {
      return endCancelled;
    },
  };

  return handlers as IncrementalStreamHandlers & {
    sessionEvents: SessionEvent[];
    segmentEvents: SegmentEvent[];
    ended: boolean;
    endCancelled: boolean | null;
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncrementalStreamingTtsEngine (request-centric)', () => {
  describe('factory / engine-level', () => {
    it('exposes instanceId from underlying engine', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      expect(engine.instanceId).toBe('mock_streaming_1');
    });

    it('delegates getModelInfo / getSampleRate / getNumSpeakers', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      expect(await engine.getModelInfo()).toEqual({
        sampleRate: 22050,
        numSpeakers: 1,
      });
      expect(await engine.getSampleRate()).toBe(22050);
      expect(await engine.getNumSpeakers()).toBe(1);
    });

    it('rejects concurrent requests', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const streamOpts = { playback: false, emitChunks: false };

      // First request — OK
      engine.generateIncrementalSpeechStream(undefined, handlers, streamOpts);

      // Second simultaneous request — should throw
      expect(() =>
        engine.generateIncrementalSpeechStream(
          undefined,
          createHandlers(),
          streamOpts
        )
      ).toThrow(/already active/);
    });

    it('allows a new request after previous flush completes', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers1 = createHandlers();
      const streamOpts = { playback: false, emitChunks: false };

      const ctrl1 = engine.generateIncrementalSpeechStream(
        undefined,
        handlers1,
        streamOpts
      );
      ctrl1.pushText('Request one text.');
      const flushP = ctrl1.flush();
      await tick();
      mock.completeNext();
      await flushP;

      // Now a second request should succeed
      const handlers2 = createHandlers();
      const ctrl2 = engine.generateIncrementalSpeechStream(
        undefined,
        handlers2,
        streamOpts
      );
      expect(ctrl2.state).toBe('idle');
    });

    it('allows a new request after previous cancel', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const streamOpts = { playback: false, emitChunks: false };

      const ctrl1 = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        streamOpts
      );
      ctrl1.pushText('Will cancel.');
      ctrl1.commit();
      await tick();
      await ctrl1.cancel();

      const ctrl2 = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        streamOpts
      );
      expect(ctrl2.state).toBe('idle');
    });

    it('throws after destroy', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      await engine.destroy();
      expect(() =>
        engine.generateIncrementalSpeechStream(undefined, createHandlers(), {
          playback: false,
          emitChunks: false,
        })
      ).toThrow(/destroyed/);
    });

    it('destroy cancels active request and releases activeRequest', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        handlers,
        { playback: false, emitChunks: false }
      );

      ctrl.pushText('Some text here to process.');
      ctrl.commit();
      await tick();

      // Destroy while request is active
      await engine.destroy();

      // The active request should have been cancelled
      expect(ctrl.state).toBe('cancelled');
      expect(handlers.ended).toBe(true);
      expect(handlers.endCancelled).toBe(true);
    });
  });

  describe('controller lifecycle', () => {
    it('starts in idle state', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        { playback: false, emitChunks: false }
      );
      expect(ctrl.state).toBe('idle');
    });

    it('transitions to active on pushText', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Hello world. ');
      expect(ctrl.state).toBe('active');
      expect(handlers.sessionEvents[0]!.type).toBe('session:started');
    });

    it('throws on pushText after cancel', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        { playback: false, emitChunks: false }
      );
      ctrl.pushText('Some text here.');
      ctrl.commit();
      await tick();
      await ctrl.cancel();

      expect(() => ctrl.pushText('x')).toThrow(/cancelled/);
    });
  });

  describe('commit and queue', () => {
    it('commit enqueues a segment and dispatches', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Hello world test text.');
      ctrl.commit();
      await tick();

      expect(
        handlers.segmentEvents.some(
          (e: SegmentEvent) => e.type === 'segment:queued'
        )
      ).toBe(true);
      expect(
        handlers.segmentEvents.some(
          (e: SegmentEvent) => e.type === 'segment:started'
        )
      ).toBe(true);
      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Hello world test text.');
    });

    it('commit with empty buffer is a no-op', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.commit();
      expect(handlers.segmentEvents).toHaveLength(0);
    });

    it('commit({ force: false }) respects min-length threshold', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions({
          segmentation: {
            debounceMs: 0,
            maxWaitMs: 0,
            minCharsPerSegment: 50, // high threshold
          },
        }),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      // Short text — below minCharsPerSegment, no boundary char → nothing committed
      ctrl.pushText('Short text');
      ctrl.commit({ force: false });
      expect(handlers.segmentEvents).toHaveLength(0);

      // force=true (default) commits regardless
      ctrl.commit();
      expect(
        handlers.segmentEvents.some(
          (e: SegmentEvent) => e.type === 'segment:queued'
        )
      ).toBe(true);
    });

    it('preserves FIFO ordering', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        { playback: false, emitChunks: false }
      );

      ctrl.pushText('First segment text here.');
      ctrl.commit();
      ctrl.pushText('Second segment text here.');
      ctrl.commit();

      await tick();

      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('First segment text here.');

      mock.completeNext();
      await tick();

      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Second segment text here.');
    });
  });

  describe('flush', () => {
    it('commits remaining buffer and waits for completion', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Flush this text here.');
      const flushPromise = ctrl.flush();

      await tick();
      expect(mock.pendingStreams).toHaveLength(1);

      let resolved = false;
      void flushPromise.then(() => {
        resolved = true;
      });
      await tick();
      expect(resolved).toBe(false);

      mock.completeNext();
      await tick();

      expect(resolved).toBe(true);
      expect(handlers.ended).toBe(true);
      expect(handlers.endCancelled).toBe(false);
    });

    it('resolves immediately when nothing to process', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      await ctrl.flush();
      expect(handlers.ended).toBe(true);
      expect(handlers.endCancelled).toBe(false);
    });

    it('emits draining event', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Drain me please now.');
      const flushPromise = ctrl.flush();
      await tick();

      expect(
        handlers.sessionEvents.some(
          (e: SessionEvent) => e.type === 'session:draining'
        )
      ).toBe(true);

      mock.completeNext();
      await flushPromise;
    });
  });

  describe('cancel', () => {
    it('cancels active and queued segments', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Active segment text.');
      ctrl.commit();
      ctrl.pushText('Queued segment text.');
      ctrl.commit();

      await tick();

      await ctrl.cancel();

      expect(ctrl.state).toBe('cancelled');
      expect(handlers.ended).toBe(true);
      expect(handlers.endCancelled).toBe(true);
      const cancelledEvent = handlers.sessionEvents.find(
        (e: SessionEvent) => e.type === 'session:cancelled'
      );
      expect(cancelledEvent).toBeDefined();
    });

    it('cancel scope=queued keeps active running', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        handlers,
        { playback: false, emitChunks: false }
      );

      ctrl.pushText('Active segment text.');
      ctrl.commit();
      ctrl.pushText('Queued segment text.');
      ctrl.commit();

      await tick();

      await ctrl.cancel({ scope: 'queued' });
      // Active segment still running — state must not be 'cancelled'
      expect(mock.pendingStreams).toHaveLength(1);
      expect(ctrl.state).not.toBe('cancelled');
      // The request itself is not ended: no onEnd should have fired
      expect(handlers.ended).toBe(false);
    });

    it('resolves pending flush on cancel', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        { playback: false, emitChunks: false }
      );

      ctrl.pushText('Flushing text content.');
      const flushPromise = ctrl.flush();
      await tick();

      let resolved = false;
      void flushPromise.then(() => {
        resolved = true;
      });

      await ctrl.cancel();
      await tick();
      expect(resolved).toBe(true);
    });

    it('flush after cancel is a no-op (no double onEnd)', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });

      let endCount = 0;
      const handlers: IncrementalStreamHandlers = {
        onEnd: () => {
          endCount++;
        },
      };

      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        handlers,
        { playback: false, emitChunks: false }
      );

      ctrl.pushText('Some text here.');
      ctrl.commit();
      await tick();
      await ctrl.cancel();

      // onEnd fired exactly once (from cancel)
      expect(endCount).toBe(1);

      // flush on an already-cancelled request must not fire onEnd again
      await ctrl.flush();
      expect(endCount).toBe(1);
    });
  });

  describe('error handling', () => {
    it('continues dispatching after segment error', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('First segment fails.');
      ctrl.commit();
      ctrl.pushText('Second segment works.');
      ctrl.commit();

      await tick();

      mock.failNext('synth error');
      await tick();

      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Second segment works.');

      expect(
        handlers.sessionEvents.some(
          (e: SessionEvent) => e.type === 'session:error'
        )
      ).toBe(true);
    });
  });

  describe('metrics', () => {
    it('tracks queue depth and counters', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl = engine.generateIncrementalSpeechStream(
        undefined,
        createHandlers(),
        { playback: false, emitChunks: false }
      );

      expect(ctrl.getMetrics().queueDepth).toBe(0);
      expect(ctrl.getMetrics().totalSegmentsQueued).toBe(0);

      ctrl.pushText('Segment one text here.');
      ctrl.commit();
      ctrl.pushText('Segment two text here.');
      ctrl.commit();

      await tick();

      expect(ctrl.getMetrics().queueDepth).toBe(1);
      expect(ctrl.getMetrics().totalSegmentsQueued).toBe(2);
      expect(ctrl.getMetrics().activeSegmentId).not.toBeNull();

      mock.completeNext();
      await tick();

      expect(ctrl.getMetrics().totalSegmentsCompleted).toBe(1);
      expect(ctrl.getMetrics().queueDepth).toBe(0);
    });
  });

  describe('auto-segmentation', () => {
    it('splits on punctuation with debounceMs=0', async () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions({
          segmentation: {
            debounceMs: 0,
            maxWaitMs: 0,
            minCharsPerSegment: 5,
          },
        }),
      });
      const handlers = createHandlers();
      const ctrl = engine.generateIncrementalSpeechStream(undefined, handlers, {
        playback: false,
        emitChunks: false,
      });

      ctrl.pushText('Hello world. How are you?');
      await tick();

      const queuedEvents = handlers.segmentEvents.filter(
        (e: SegmentEvent) => e.type === 'segment:queued'
      );
      expect(queuedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('player proxy', () => {
    it('returns null player when playback is false', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl: IncrementalStreamController =
        engine.generateIncrementalSpeechStream(undefined, createHandlers(), {
          playback: false,
          emitChunks: false,
        });
      expect(ctrl.player).toBeNull();
    });

    it('returns a player proxy when playback is true', () => {
      const mock = createMockStreamingEngine();
      const engine = createEngine(mock, {
        source: { engine: mock },
        ...createFactoryOptions(),
      });
      const ctrl: IncrementalStreamController =
        engine.generateIncrementalSpeechStream(undefined, createHandlers(), {
          playback: true,
          emitChunks: false,
        });
      expect(ctrl.player).not.toBeNull();
      expect(ctrl.player!.feed).toBe('native');
    });
  });
});
