import type {
  SessionId,
  SegmentId,
  SessionState,
  IncrementalStreamingTtsEngine,
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamController,
  IncrementalStreamHandlers,
  IncrementalRequestOptions,
  IncrementalMetrics,
  CommitOptions,
  CancelOptions,
  SessionEvent,
  SegmentEvent,
} from './types';
import type { StreamingTtsEngine, TtsPipelineOptions } from '../streamingTypes';
import type { LiveAudioBufferIdSource } from '../../audiobuffer/types';
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
  sessionCancelled,
  sessionError,
  segmentQueued,
  segmentDropped,
  metricsSnapshot,
} from './events';
import {
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  releasePipelineTextBuffer,
} from '../../textbuffer';

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
  let activeSessionCancel: (() => Promise<void>) | null = null;

  const guard = () => {
    if (destroyed) {
      throw new Error('IncrementalStreamingTtsEngine has been destroyed.');
    }
  };

  const engine: IncrementalStreamingTtsEngine = {
    get instanceId() {
      return streamingEngine.instanceId;
    },

    async startSession(
      audioOut: LiveAudioBufferIdSource,
      ttsOptions?: TtsPipelineOptions,
      incrementalOptions?: IncrementalRequestOptions
    ): Promise<IncrementalStreamController> {
      guard();
      if (activeSessionCancel) {
        throw new Error(
          'An incremental session is already active. ' +
            'Cancel or flush the current session before starting a new one.'
        );
      }

      const segPolicy = resolveSegmentationPolicy(
        incrementalOptions?.segmentation ?? factoryOptions.segmentation
      );
      const qPolicy = resolveQueuePolicy(
        incrementalOptions?.queue ?? factoryOptions.queue
      );

      const session = await createPipelineSession(
        streamingEngine,
        audioOut,
        ttsOptions,
        segPolicy,
        qPolicy,
        () => {
          activeSessionCancel = null;
        }
      );

      activeSessionCancel = session.cancel;
      return session.controller;
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
      if (activeSessionCancel) {
        try {
          await activeSessionCancel();
        } catch {
          /* ignore */
        }
        activeSessionCancel = null;
      }
    },
  };

  return engine;
}

// ---------------------------------------------------------------------------
// Per-session pipeline (internal)
// ---------------------------------------------------------------------------

interface PipelineSession {
  controller: IncrementalStreamController;
  cancel: () => Promise<void>;
}

async function createPipelineSession(
  streamingEngine: StreamingTtsEngine,
  audioOut: LiveAudioBufferIdSource,
  ttsOptions: TtsPipelineOptions | undefined,
  segPolicy: ResolvedSegmentationPolicy,
  qPolicy: ResolvedQueuePolicy,
  onSessionEnd: () => void
): Promise<PipelineSession> {
  const sessionId = nextSessionId();

  // Create internal LiveTextBuffer
  const textBufferRef = await createLiveTextBuffer({
    emitPartialEvents: false,
  });
  const textBufferId = textBufferRef.bufferId;

  // Start the TTS pipeline: textBuffer -> audioOut
  const pipelineHandle = await streamingEngine.synthesize(
    textBufferId,
    audioOut,
    ttsOptions
  );

  // -----------------------------------------------------------------------
  // Internal mutable state
  // -----------------------------------------------------------------------

  let state: SessionState = 'idle';
  let textAccumulator = '';
  const queue: QueuedSegment[] = [];
  let commitCounter = 0;

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

  // Per-segment meta (current meta from pushText)
  let currentMeta: { sid?: number; speed?: number } | undefined;

  // -----------------------------------------------------------------------
  // Event helpers
  // -----------------------------------------------------------------------

  // Handlers object; could be wired from incrementalOptions in the future
  const handlers: IncrementalStreamHandlers = {};

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
      null
    );
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  function setState(next: SessionState): void {
    state = next;
  }

  function completeSession(): void {
    onSessionEnd();
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
    if (textAccumulator.length > 0 && segPolicy.maxWaitMs > 0) {
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
      ? detectBoundaries(textAccumulator, segPolicy, {
          forced: true,
          reason: 'timeout',
        })
      : detectBoundaries(textAccumulator, segPolicy);

    if (boundaries.length === 0) return;

    for (const b of boundaries) {
      enqueueAndCommitText(b.text);
      textAccumulator = b.remainder;
    }
  }

  // -----------------------------------------------------------------------
  // Queue management + native commit
  // -----------------------------------------------------------------------

  function enqueueAndCommitText(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const seg: QueuedSegment = { id: nextSegmentId(), text: trimmed };
    const result = applyEnqueuePolicy(queue, seg, qPolicy);

    for (const d of result.dropped) {
      const reason =
        qPolicy.mode === 'replace-tail' || qPolicy.mode === 'latest-wins'
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
      emitSegment(segmentQueued(sessionId, seg.id, seg.text, commitCounter));

      // Commit segment to native LiveTextBuffer -- the pipeline worker picks it up
      const meta: Record<string, unknown> | undefined = currentMeta
        ? { ...currentMeta }
        : undefined;

      appendLiveTextSegment(textBufferId, seg.text, undefined, undefined, meta)
        .then(() => {
          commitCounter++;
          totalCompleted++;
          // Remove from local queue tracking
          const idx = queue.indexOf(seg);
          if (idx >= 0) queue.splice(idx, 1);
          emitMetrics();
          maybeTransitionIdle();
        })
        .catch((err) => {
          totalDropped++;
          // Remove failed segment from queue to prevent deadlock
          const idx = queue.indexOf(seg);
          if (idx >= 0) queue.splice(idx, 1);
          const msg = err instanceof Error ? err.message : String(err);
          emitSession(sessionError(sessionId, msg, seg.id));
          emitMetrics();
          maybeTransitionIdle();
        });
    } else {
      totalDropped++;
      emitSegment(segmentDropped(sessionId, seg.id, 'overflow'));
    }

    emitMetrics();
  }

  // -----------------------------------------------------------------------
  // Idle transition
  // -----------------------------------------------------------------------

  function maybeTransitionIdle(): void {
    if (queue.length > 0) return;

    if (flushing) {
      flushing = false;
      setState('idle');
      emitSession(sessionIdle(sessionId));
      emitMetrics();
      completeSession();
      flushResolve?.();
      flushResolve = null;
    } else if (state === 'active' || state === 'draining') {
      setState('idle');
      emitSession(sessionIdle(sessionId));
      emitMetrics();
    }
  }

  // -----------------------------------------------------------------------
  // Shared controller methods
  // -----------------------------------------------------------------------

  function pushTextImpl(
    text: string,
    meta?: { sid?: number; speed?: number }
  ): void {
    if (state === 'destroyed') {
      throw new Error('Cannot pushText: session has been destroyed.');
    }
    if (state === 'cancelled') {
      throw new Error('Cannot pushText: session has been cancelled.');
    }

    currentMeta = meta;
    textAccumulator += text;

    if (state === 'idle') {
      setState('active');
      emitSession(sessionStarted(sessionId));
    }

    resetWaitTimer();
    resetDebounceTimer();
  }

  function commitImpl(opts?: CommitOptions): void {
    if (state === 'destroyed') {
      throw new Error('Cannot commit: session has been destroyed.');
    }
    if (state === 'cancelled') {
      throw new Error('Cannot commit: session has been cancelled.');
    }

    clearTimers();
    if (textAccumulator.length === 0) return;

    const force = opts?.force !== false;
    if (force) {
      const boundaries = detectBoundaries(textAccumulator, segPolicy, {
        forced: true,
      });
      for (const b of boundaries) {
        enqueueAndCommitText(b.text);
      }
      textAccumulator = '';
    } else {
      const boundaries = detectBoundaries(textAccumulator, segPolicy);
      for (const b of boundaries) {
        enqueueAndCommitText(b.text);
      }
      if (boundaries.length > 0) {
        const last = boundaries[boundaries.length - 1];
        if (last) {
          textAccumulator = last.remainder;
        }
      }
    }
  }

  async function flushImpl(): Promise<void> {
    if (state === 'destroyed') {
      throw new Error('Cannot flush: session has been destroyed.');
    }
    if (state === 'cancelled') {
      return;
    }

    clearTimers();

    // Commit any remaining text
    if (textAccumulator.length > 0) {
      const boundaries = detectBoundaries(textAccumulator, segPolicy, {
        forced: true,
      });
      for (const b of boundaries) {
        enqueueAndCommitText(b.text);
      }
      textAccumulator = '';
    }

    // Finalize the text buffer -- signals to the native worker no more segments coming
    try {
      await finalizeLiveTextBuffer(textBufferId);
    } catch {
      // ignore -- buffer may already be finalized
    }

    // Flush the pipeline to process all remaining segments
    try {
      await pipelineHandle.flush();
    } catch {
      // ignore
    }

    setState('idle');
    emitSession(sessionIdle(sessionId));
    emitMetrics();
    completeSession();
  }

  async function cancelImpl(opts?: CancelOptions): Promise<void> {
    if (state === 'destroyed') return;

    const scope = opts?.scope ?? 'all';

    if (scope === 'queued') {
      if (state === 'cancelled') return;
      clearTimers();
      textAccumulator = '';
      for (const seg of queue) {
        emitSegment(segmentDropped(sessionId, seg.id, 'cancelled'));
        totalDropped++;
      }
      queue.length = 0;
      // Reset the pipeline cursor to skip over queued segments
      try {
        await pipelineHandle.reset();
      } catch {
        /* ignore */
      }
      emitMetrics();
      return;
    }

    // scope='active' or scope='all': end the session
    if (state === 'cancelled') return;
    clearTimers();

    let droppedCount = 0;

    if (scope === 'all') {
      for (const seg of queue) {
        emitSegment(segmentDropped(sessionId, seg.id, 'cancelled'));
        droppedCount++;
        totalDropped++;
      }
      queue.length = 0;
      textAccumulator = '';
    }

    // Stop the pipeline
    try {
      await pipelineHandle.stop();
    } catch {
      /* ignore */
    }

    // Release the internal text buffer
    try {
      await releasePipelineTextBuffer(textBufferId);
    } catch {
      /* ignore */
    }

    setState('cancelled');
    emitSession(sessionCancelled(sessionId, droppedCount));
    completeSession();

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

  const controller: IncrementalStreamController = {
    pushText: pushTextImpl,
    commit: commitImpl,
    flush: flushImpl,
    cancel: cancelImpl,
    getMetrics: getMetricsImpl,
    get pipeline() {
      return pipelineHandle;
    },
    get textBuffer() {
      return { bufferId: textBufferId as string };
    },
    get state() {
      return state;
    },
  };
  return { controller, cancel: () => cancelImpl({ scope: 'all' }) };
}
