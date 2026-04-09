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
  IncrementalStreamingTtsOptions,
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
// Helper to collect events
// ---------------------------------------------------------------------------

function createOptions(
  mockEngine: StreamingTtsEngine,
  overrides?: Partial<IncrementalStreamingTtsOptions>
): IncrementalStreamingTtsOptions & {
  sessionEvents: SessionEvent[];
  segmentEvents: SegmentEvent[];
} {
  const sessionEvents: SessionEvent[] = [];
  const segmentEvents: SegmentEvent[] = [];

  const opts: IncrementalStreamingTtsOptions = {
    source: { engine: mockEngine },
    segmentation: {
      // Disable timers for deterministic tests
      maxWaitMs: 0,
      debounceMs: 0,
      minCharsPerSegment: 5,
    },
    streamOptions: { playback: false, emitChunks: false },
    onSessionEvent: (e) => sessionEvents.push(e),
    onSegmentEvent: (e) => segmentEvents.push(e),
    ...overrides,
  };

  return Object.assign(opts, { sessionEvents, segmentEvents });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncrementalStreamingTtsEngine', () => {
  describe('lifecycle', () => {
    it('starts in idle state', () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);
      expect(engine.state).toBe('idle');
    });

    it('transitions to active on pushText', () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Hello world. ');
      expect(engine.state).toBe('active');
      expect(opts.sessionEvents[0]!.type).toBe('session:started');
    });

    it('throws on pushText after destroy', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      await engine.destroy();
      expect(engine.state).toBe('destroyed');
      expect(() => engine.pushText('x')).toThrow('destroyed');
    });

    it('throws on commit after destroy', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      await engine.destroy();
      expect(() => engine.commit()).toThrow('destroyed');
    });

    it('destroy is idempotent', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      await engine.destroy();
      await engine.destroy(); // should not throw
      expect(engine.state).toBe('destroyed');
    });
  });

  describe('commit and queue', () => {
    it('commit enqueues a segment', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Hello world test text.');
      engine.commit();

      // Wait a tick for async dispatch
      await tick();

      expect(opts.segmentEvents.some((e) => e.type === 'segment:queued')).toBe(
        true
      );
      expect(opts.segmentEvents.some((e) => e.type === 'segment:started')).toBe(
        true
      );
      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Hello world test text.');
    });

    it('commit with empty buffer is a no-op', () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.commit();
      expect(opts.segmentEvents).toHaveLength(0);
    });

    it('preserves FIFO ordering', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('First segment text here.');
      engine.commit();
      engine.pushText('Second segment text here.');
      engine.commit();

      await tick();

      // First segment dispatched
      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('First segment text here.');

      // Complete first → second gets dispatched
      mock.completeNext();
      await tick();

      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Second segment text here.');
    });
  });

  describe('flush', () => {
    it('commits remaining buffer and waits for completion', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Flush this text here.');
      const flushPromise = engine.flush();

      await tick();

      expect(mock.pendingStreams).toHaveLength(1);

      // Not resolved yet
      let resolved = false;
      void flushPromise.then(() => {
        resolved = true;
      });
      await tick();
      expect(resolved).toBe(false);

      // Complete the segment
      mock.completeNext();
      await tick();

      expect(resolved).toBe(true);
      expect(engine.state).toBe('idle');
    });

    it('resolves immediately when nothing to process', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      await engine.flush(); // should not hang
      expect(engine.state).toBe('idle');
    });

    it('emits draining event', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Drain me please now.');
      const flushPromise = engine.flush();

      await tick();

      expect(
        opts.sessionEvents.some((e) => e.type === 'session:draining')
      ).toBe(true);

      mock.completeNext();
      await flushPromise;
    });
  });

  describe('cancel', () => {
    it('cancels active and queued segments', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Active segment text.');
      engine.commit();
      engine.pushText('Queued segment text.');
      engine.commit();

      await tick();

      await engine.cancel();

      expect(engine.state).toBe('cancelled');
      const cancelledEvent = opts.sessionEvents.find(
        (e) => e.type === 'session:cancelled'
      );
      expect(cancelledEvent).toBeDefined();
    });

    it('cancel scope=queued keeps active running', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Active segment text.');
      engine.commit();
      engine.pushText('Queued segment text.');
      engine.commit();

      await tick();

      await engine.cancel({ scope: 'queued' });

      // Active segment still running
      expect(mock.pendingStreams).toHaveLength(1);
    });

    it('allows new input after cancel', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Will be cancelled.');
      engine.commit();
      await tick();
      await engine.cancel();

      expect(engine.state).toBe('cancelled');

      // New input should work
      engine.pushText('New text after cancel.');
      expect(engine.state).toBe('active');
    });

    it('resolves pending flush on cancel', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('Flushing text content.');
      const flushPromise = engine.flush();
      await tick();

      let resolved = false;
      void flushPromise.then(() => {
        resolved = true;
      });

      await engine.cancel();
      await tick();

      expect(resolved).toBe(true);
    });
  });

  describe('error handling', () => {
    it('continues dispatching after segment error', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      engine.pushText('First segment fails.');
      engine.commit();
      engine.pushText('Second segment works.');
      engine.commit();

      await tick();

      // Fail the first segment
      mock.failNext('synth error');
      await tick();

      // Second segment should be dispatched
      expect(mock.pendingStreams).toHaveLength(1);
      expect(mock.pendingStreams[0]!.text).toBe('Second segment works.');

      // Error event should have been emitted
      expect(opts.sessionEvents.some((e) => e.type === 'session:error')).toBe(
        true
      );
    });
  });

  describe('metrics', () => {
    it('tracks queue depth and counters', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock);
      const engine = createEngine(mock, opts);

      expect(engine.getMetrics().queueDepth).toBe(0);
      expect(engine.getMetrics().totalSegmentsQueued).toBe(0);

      engine.pushText('Segment one text here.');
      engine.commit();
      engine.pushText('Segment two text here.');
      engine.commit();

      await tick();

      // One active, one queued
      expect(engine.getMetrics().queueDepth).toBe(1);
      expect(engine.getMetrics().totalSegmentsQueued).toBe(2);
      expect(engine.getMetrics().activeSegmentId).not.toBeNull();

      mock.completeNext();
      await tick();

      expect(engine.getMetrics().totalSegmentsCompleted).toBe(1);
      expect(engine.getMetrics().queueDepth).toBe(0);
    });
  });

  describe('auto-segmentation', () => {
    it('splits on punctuation with debounceMs=0', async () => {
      const mock = createMockStreamingEngine();
      const opts = createOptions(mock, {
        segmentation: {
          debounceMs: 0,
          maxWaitMs: 0,
          minCharsPerSegment: 5,
        },
      });
      const engine = createEngine(mock, opts);

      engine.pushText('Hello world. How are you?');

      // With debounceMs=0, segmentation runs synchronously
      await tick();

      // Should have detected punctuation boundaries
      const queuedEvents = opts.segmentEvents.filter(
        (e) => e.type === 'segment:queued'
      );
      expect(queuedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
