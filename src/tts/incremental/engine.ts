import type {
  SessionId,
  SegmentId,
  SessionState,
  IncrementalStreamingTtsEngine,
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamController,
  IncrementalStreamFileController,
  IncrementalStreamHandlers,
  IncrementalStreamToFileHandlers,
  IncrementalRequestOptions,
  IncrementalMetrics,
  CommitOptions,
  CancelOptions,
  SessionEvent,
  SegmentEvent,
} from './types';
import type { StreamingTtsEngine } from '../streamingTypes';
import type {
  TtsStreamController,
  TtsStreamOptions,
  TtsGenerationOptions,
  TtsStreamToFileOptions,
} from '../types';
import type { PcmPlayer } from '../../pcm/types';
import {
  resolveSegmentationPolicy,
  detectBoundaries,
  type ResolvedSegmentationPolicy,
} from './segmenter';
import {
  resolveQueuePolicy,
  applyEnqueuePolicy,
  type QueuedSegment,
  type ResolvedQueuePolicy,
} from './policies';
import {
  sessionStarted,
  sessionIdle,
  sessionDraining,
  sessionCancelled,
  sessionError,
  segmentQueued,
  segmentStarted,
  segmentEnded,
  segmentDropped,
  segmentChunk,
  metricsSnapshot,
} from './events';

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

let sessionCounter = 0;
let segmentCounter = 0;

function nextSessionId(): SessionId {
  return `inc_session_${++sessionCounter}`;
}

function nextSegmentId(): SegmentId {
  return `inc_seg_${++segmentCounter}`;
}

// ---------------------------------------------------------------------------
// Engine factory (returns IncrementalStreamingTtsEngine)
// ---------------------------------------------------------------------------

export function createEngine(
  streamingEngine: StreamingTtsEngine,
  factoryOptions: IncrementalStreamingTtsFactoryOptions
): IncrementalStreamingTtsEngine {
  let destroyed = false;
  let activeRequest = false;

  const guard = () => {
    if (destroyed) {
      throw new Error('IncrementalStreamingTtsEngine has been destroyed.');
    }
  };

  const engine: IncrementalStreamingTtsEngine = {
    get instanceId() {
      return streamingEngine.instanceId;
    },

    generateIncrementalSpeechStream(
      genOptions: TtsGenerationOptions | undefined,
      handlers: IncrementalStreamHandlers,
      streamOptions?: TtsStreamOptions,
      incrementalOptions?: IncrementalRequestOptions
    ): IncrementalStreamController {
      guard();
      if (activeRequest) {
        throw new Error(
          'An incremental request is already active. ' +
            'Cancel or flush the current request before starting a new one.'
        );
      }
      activeRequest = true;

      const resolvedStreamOptions = streamOptions ?? {
        playback: true,
        emitChunks: false,
      };

      const segPolicy = resolveSegmentationPolicy(
        incrementalOptions?.segmentation ?? factoryOptions.segmentation
      );
      const qPolicy = resolveQueuePolicy(
        incrementalOptions?.queue ?? factoryOptions.queue
      );

      const session = createRequestSession(
        streamingEngine,
        genOptions,
        handlers,
        segPolicy,
        qPolicy,
        resolvedStreamOptions,
        'stream',
        undefined,
        () => {
          activeRequest = false;
        }
      );

      return session.controller as IncrementalStreamController;
    },

    generateIncrementalSpeechStreamToFile(
      genOptions: TtsGenerationOptions | undefined,
      fileOptions: TtsStreamToFileOptions,
      handlers: IncrementalStreamToFileHandlers,
      incrementalOptions?: IncrementalRequestOptions
    ): IncrementalStreamFileController {
      guard();
      if (activeRequest) {
        throw new Error(
          'An incremental request is already active. ' +
            'Cancel or flush the current request before starting a new one.'
        );
      }
      activeRequest = true;

      const segPolicy = resolveSegmentationPolicy(
        incrementalOptions?.segmentation ?? factoryOptions.segmentation
      );
      const qPolicy = resolveQueuePolicy(
        incrementalOptions?.queue ?? factoryOptions.queue
      );

      const session = createRequestSession(
        streamingEngine,
        genOptions,
        handlers,
        segPolicy,
        qPolicy,
        undefined,
        'file',
        fileOptions,
        () => {
          activeRequest = false;
        }
      );

      return session.controller as IncrementalStreamFileController;
    },

    async getModelInfo() {
      guard();
      return streamingEngine.getModelInfo();
    },

    async getSampleRate() {
      guard();
      return streamingEngine.getSampleRate();
    },

    async getNumSpeakers() {
      guard();
      return streamingEngine.getNumSpeakers();
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
    },
  };

  return engine;
}

// ---------------------------------------------------------------------------
// Per-request session (internal)
// ---------------------------------------------------------------------------

interface RequestSession {
  controller: IncrementalStreamController | IncrementalStreamFileController;
}

function createRequestSession(
  streamingEngine: StreamingTtsEngine,
  genOptions: TtsGenerationOptions | undefined,
  handlers: IncrementalStreamHandlers | IncrementalStreamToFileHandlers,
  segPolicy: ResolvedSegmentationPolicy,
  qPolicy: ResolvedQueuePolicy,
  streamOptions: TtsStreamOptions | undefined,
  mode: 'stream' | 'file',
  fileOptions: TtsStreamToFileOptions | undefined,
  onRequestEnd: () => void
): RequestSession {
  const sessionId = nextSessionId();

  // -----------------------------------------------------------------------
  // Internal mutable state
  // -----------------------------------------------------------------------

  let state: SessionState = 'idle';
  let textBuffer = '';
  const queue: QueuedSegment[] = [];
  let activeSegment: QueuedSegment | null = null;
  let activeController: TtsStreamController | null = null;
  let dispatching = false;

  // Flush support
  let flushResolve: (() => void) | null = null;
  let flushing = false;

  // Timers
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;

  // Counters
  let totalQueued = 0;
  let totalCompleted = 0;
  let totalDropped = 0;
  let totalReplaced = 0;

  // Player proxy state (only for stream mode with playback)
  let isPaused = false;

  // -----------------------------------------------------------------------
  // Event helpers
  // -----------------------------------------------------------------------

  const emitSession = (e: SessionEvent) => {
    try {
      handlers.onSessionEvent?.(e);
    } catch {
      /* subscriber errors must not break the engine */
    }
  };
  const emitSegment = (e: SegmentEvent) => {
    try {
      handlers.onSegmentEvent?.(e);
    } catch {
      /* subscriber errors must not break the engine */
    }
  };

  function emitMetrics(): void {
    try {
      handlers.onMetrics?.(buildMetrics());
    } catch {
      /* subscriber errors must not break the engine */
    }
  }

  function buildMetrics(): IncrementalMetrics {
    return metricsSnapshot(
      queue.length,
      totalQueued,
      totalCompleted,
      totalDropped,
      totalReplaced,
      activeSegment?.id ?? null
    );
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  function setState(next: SessionState): void {
    state = next;
  }

  function completeRequest(): void {
    onRequestEnd();
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  function clearTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  }

  function resetWaitTimer(): void {
    if (waitTimer !== null) clearTimeout(waitTimer);
    if (textBuffer.length > 0 && segPolicy.maxWaitMs > 0) {
      waitTimer = setTimeout(() => {
        waitTimer = null;
        autoSegment(true);
      }, segPolicy.maxWaitMs);
    }
  }

  function resetDebounceTimer(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (segPolicy.debounceMs > 0) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        autoSegment(false);
      }, segPolicy.debounceMs);
    } else {
      autoSegment(false);
    }
  }

  // -----------------------------------------------------------------------
  // Auto-segmentation
  // -----------------------------------------------------------------------

  function autoSegment(isTimeout: boolean): void {
    if (state === 'destroyed' || state === 'cancelled') return;

    const boundaries = isTimeout
      ? detectBoundaries(textBuffer, segPolicy, {
          forced: true,
          reason: 'timeout',
        })
      : detectBoundaries(textBuffer, segPolicy);

    if (boundaries.length === 0) return;

    for (const b of boundaries) {
      enqueueText(b.text);
      textBuffer = b.remainder;
    }

    scheduleDispatch();
  }

  // -----------------------------------------------------------------------
  // Queue management
  // -----------------------------------------------------------------------

  function enqueueText(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const seg: QueuedSegment = { id: nextSegmentId(), text: trimmed };
    const result = applyEnqueuePolicy(queue, seg, qPolicy);

    for (const d of result.dropped) {
      const reason =
        qPolicy.mode === 'replace-tail'
          ? ('replaced' as const)
          : ('overflow' as const);
      if (reason === 'replaced') {
        totalReplaced++;
      } else {
        totalDropped++;
      }
      emitSegment(segmentDropped(sessionId, d.id, reason));
    }

    if (result.accepted) {
      totalQueued++;
      emitSegment(segmentQueued(sessionId, seg.id, seg.text, queue.length - 1));
    } else {
      totalDropped++;
      emitSegment(segmentDropped(sessionId, seg.id, 'overflow'));
    }

    emitMetrics();
  }

  // -----------------------------------------------------------------------
  // Dispatch loop (one segment at a time)
  // -----------------------------------------------------------------------

  function scheduleDispatch(): void {
    if (dispatching || activeSegment !== null) return;
    if (queue.length === 0) {
      maybeTransitionIdle();
      return;
    }
    dispatchNext();
  }

  function dispatchNext(): void {
    if (dispatching || state === 'destroyed' || state === 'cancelled') return;
    if (queue.length === 0) {
      maybeTransitionIdle();
      return;
    }

    dispatching = true;
    const seg = queue.shift()!;
    activeSegment = seg;

    if (state === 'idle') {
      setState('active');
      emitSession(sessionStarted(sessionId));
    }

    emitSegment(segmentStarted(sessionId, seg.id));
    emitMetrics();

    void startSegmentGeneration(seg);
  }

  async function startSegmentGeneration(seg: QueuedSegment): Promise<void> {
    try {
      const segHandlers = {
        onChunk(chunk: Parameters<NonNullable<typeof handlers.onChunk>>[0]) {
          if (activeSegment?.id === seg.id) {
            emitSegment(segmentChunk(sessionId, seg.id, chunk));
            // Propagate to top-level onChunk
            try {
              handlers.onChunk?.(chunk);
            } catch {
              /* ignore */
            }
          }
        },
        onEnd(event: { cancelled: boolean }) {
          if (activeSegment?.id !== seg.id) return;
          emitSegment(segmentEnded(sessionId, seg.id, event.cancelled));
          if (!event.cancelled) totalCompleted++;
          activeSegment = null;
          activeController = null;
          dispatching = false;
          emitMetrics();
          scheduleDispatch();
        },
        onError(error: { message: string }) {
          if (activeSegment?.id !== seg.id) return;
          activeSegment = null;
          activeController = null;
          dispatching = false;
          emitSession(sessionError(sessionId, error.message, seg.id));
          // Propagate to top-level onError
          try {
            handlers.onError?.(error as never);
          } catch {
            /* ignore */
          }
          emitMetrics();
          scheduleDispatch();
        },
      };

      let controller: TtsStreamController;

      if (mode === 'file' && fileOptions) {
        // File mode: dispatch via generateSpeechStreamToFile
        const fileCtrl = await streamingEngine.generateSpeechStreamToFile(
          seg.text,
          genOptions,
          fileOptions,
          segHandlers as never
        );
        // Wrap into TtsStreamController shape for uniform handling
        controller = {
          async cancel() {
            return fileCtrl.cancel();
          },
          unsubscribe() {
            fileCtrl.unsubscribe();
          },
          player: null,
        };
      } else {
        // Stream mode
        controller = await streamingEngine.generateSpeechStream(
          seg.text,
          genOptions,
          segHandlers,
          streamOptions
        );
      }

      if (activeSegment?.id === seg.id) {
        activeController = controller;
        // Apply paused state to new segment player
        if (isPaused && controller.player) {
          try {
            void controller.player.pause();
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err: unknown) {
      activeSegment = null;
      dispatching = false;
      const msg = err instanceof Error ? err.message : String(err);
      emitSession(sessionError(sessionId, msg, seg.id));
      emitMetrics();
      scheduleDispatch();
    }
  }

  // -----------------------------------------------------------------------
  // Idle / drain-complete transition
  // -----------------------------------------------------------------------

  function maybeTransitionIdle(): void {
    if (activeSegment !== null || queue.length > 0) return;

    if (flushing) {
      flushing = false;
      setState('idle');
      emitSession(sessionIdle(sessionId));
      emitMetrics();
      // Fire top-level onEnd at flush completion
      try {
        (handlers as IncrementalStreamHandlers).onEnd?.({ cancelled: false });
      } catch {
        /* ignore */
      }
      completeRequest();
      flushResolve?.();
      flushResolve = null;
    } else if (state === 'active' || state === 'draining') {
      setState('idle');
      emitSession(sessionIdle(sessionId));
      emitMetrics();
    }
  }

  // -----------------------------------------------------------------------
  // Player proxy (for stream mode with playback)
  // -----------------------------------------------------------------------

  function createPlayerProxy(): PcmPlayer | null {
    if (mode !== 'stream' || !streamOptions?.playback) return null;

    const proxy: PcmPlayer = {
      get playerId() {
        return `inc_player_proxy_${sessionId}`;
      },
      get feed() {
        return 'native' as const;
      },
      async writePcmChunk(): Promise<void> {
        throw new Error(
          `PcmPlayer proxy ${sessionId} has feed 'native'; writePcmChunk() is not allowed from JS.`
        );
      },
      async pause(): Promise<void> {
        isPaused = true;
        if (activeController?.player) {
          await activeController.player.pause();
        }
      },
      async resume(): Promise<void> {
        isPaused = false;
        if (activeController?.player) {
          await activeController.player.resume();
        }
      },
      async destroy(): Promise<void> {
        await cancelImpl({ scope: 'all' });
      },
    };
    return proxy;
  }

  // -----------------------------------------------------------------------
  // Shared controller methods
  // -----------------------------------------------------------------------

  function pushTextImpl(text: string): void {
    if (state === 'destroyed') {
      throw new Error('Cannot pushText: request has been destroyed.');
    }
    if (state === 'cancelled') {
      throw new Error('Cannot pushText: request has been cancelled.');
    }

    textBuffer += text;

    if (state === 'idle') {
      setState('active');
      emitSession(sessionStarted(sessionId));
    }

    resetWaitTimer();
    resetDebounceTimer();
  }

  function commitImpl(_opts?: CommitOptions): void {
    if (state === 'destroyed') {
      throw new Error('Cannot commit: request has been destroyed.');
    }

    clearTimers();
    if (textBuffer.length === 0) return;

    const boundaries = detectBoundaries(textBuffer, segPolicy, {
      forced: true,
    });
    for (const b of boundaries) {
      enqueueText(b.text);
    }
    textBuffer = '';
    scheduleDispatch();
  }

  async function flushImpl(): Promise<void> {
    if (state === 'destroyed') {
      throw new Error('Cannot flush: request has been destroyed.');
    }

    clearTimers();

    if (textBuffer.length > 0) {
      const boundaries = detectBoundaries(textBuffer, segPolicy, {
        forced: true,
      });
      for (const b of boundaries) {
        enqueueText(b.text);
      }
      textBuffer = '';
    }

    if (queue.length === 0 && activeSegment === null) {
      if (state !== 'idle') {
        setState('idle');
        emitSession(sessionIdle(sessionId));
        emitMetrics();
      }
      // Fire top-level onEnd
      try {
        (handlers as IncrementalStreamHandlers).onEnd?.({ cancelled: false });
      } catch {
        /* ignore */
      }
      completeRequest();
      return;
    }

    flushing = true;
    setState('draining');
    emitSession(
      sessionDraining(sessionId, queue.length + (activeSegment ? 1 : 0))
    );

    scheduleDispatch();

    return new Promise<void>((resolve) => {
      flushResolve = resolve;
    });
  }

  async function cancelImpl(opts?: CancelOptions): Promise<void> {
    if (state === 'destroyed') return;

    const scope = opts?.scope ?? 'all';
    clearTimers();

    let droppedCount = 0;

    if (scope === 'all' || scope === 'queued') {
      for (const seg of queue) {
        emitSegment(segmentDropped(sessionId, seg.id, 'cancelled'));
        droppedCount++;
        totalDropped++;
      }
      queue.length = 0;
      textBuffer = '';
    }

    if ((scope === 'all' || scope === 'active') && activeController) {
      try {
        await activeController.cancel();
      } catch {
        /* ignore */
      }
      if (activeSegment) {
        emitSegment(segmentDropped(sessionId, activeSegment.id, 'cancelled'));
        droppedCount++;
        totalDropped++;
      }
      activeSegment = null;
      activeController = null;
      dispatching = false;
    }

    setState('cancelled');
    emitSession(sessionCancelled(sessionId, droppedCount));

    // Fire top-level onEnd with cancelled
    try {
      (handlers as IncrementalStreamHandlers).onEnd?.({ cancelled: true });
    } catch {
      /* ignore */
    }

    completeRequest();

    if (flushResolve) {
      flushing = false;
      flushResolve();
      flushResolve = null;
    }

    emitMetrics();
  }

  function getMetricsImpl(): IncrementalMetrics {
    return buildMetrics();
  }

  // -----------------------------------------------------------------------
  // Build controller
  // -----------------------------------------------------------------------

  const playerProxy = createPlayerProxy();

  if (mode === 'stream') {
    const controller: IncrementalStreamController = {
      pushText: pushTextImpl,
      commit: commitImpl,
      flush: flushImpl,
      cancel: cancelImpl,
      getMetrics: getMetricsImpl,
      get state() {
        return state;
      },
      get player() {
        return playerProxy;
      },
    };
    return { controller };
  }

  const controller: IncrementalStreamFileController = {
    pushText: pushTextImpl,
    commit: commitImpl,
    flush: flushImpl,
    cancel: cancelImpl,
    getMetrics: getMetricsImpl,
    get state() {
      return state;
    },
  };
  return { controller };
}
