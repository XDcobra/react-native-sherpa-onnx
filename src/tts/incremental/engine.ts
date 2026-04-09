import type {
  SessionId,
  SegmentId,
  SessionState,
  IncrementalStreamingTtsEngine,
  IncrementalStreamingTtsOptions,
  IncrementalMetrics,
  CommitOptions,
  CancelOptions,
  SessionEvent,
  SegmentEvent,
} from './types';
import type { StreamingTtsEngine } from '../streamingTypes';
import type { TtsStreamController } from '../types';
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
// Engine implementation
// ---------------------------------------------------------------------------

export function createEngine(
  streamingEngine: StreamingTtsEngine,
  options: IncrementalStreamingTtsOptions
): IncrementalStreamingTtsEngine {
  const sessionId = nextSessionId();
  const segPolicy: ResolvedSegmentationPolicy = resolveSegmentationPolicy(
    options.segmentation
  );
  const qPolicy: ResolvedQueuePolicy = resolveQueuePolicy(options.queue);

  const defaultStreamOptions = options.streamOptions ?? {
    playback: false,
    emitChunks: true,
  };

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

  // -----------------------------------------------------------------------
  // Event helpers
  // -----------------------------------------------------------------------

  const emitSession = (e: SessionEvent) => {
    try {
      options.onSessionEvent?.(e);
    } catch {
      /* subscriber errors must not break the engine */
    }
  };
  const emitSegment = (e: SegmentEvent) => {
    try {
      options.onSegmentEvent?.(e);
    } catch {
      /* subscriber errors must not break the engine */
    }
  };

  function emitMetrics(): void {
    try {
      options.onMetrics?.(buildMetrics());
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
      // No debounce — run immediately
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

    // Emit for dropped segments
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

    // Fire the native streaming call (async).
    // We intentionally don't return the promise — lifecycle is callback-driven.
    startSegmentGeneration(seg);
  }

  async function startSegmentGeneration(seg: QueuedSegment): Promise<void> {
    try {
      const controller = await streamingEngine.generateSpeechStream(
        seg.text,
        options.generationOptions,
        {
          onChunk(chunk) {
            // Only emit if the segment is still the active one (not cancelled)
            if (activeSegment?.id === seg.id) {
              emitSegment(segmentChunk(sessionId, seg.id, chunk));
            }
          },
          onEnd(event) {
            if (activeSegment?.id !== seg.id) return; // stale
            emitSegment(segmentEnded(sessionId, seg.id, event.cancelled));
            if (!event.cancelled) totalCompleted++;
            activeSegment = null;
            activeController = null;
            dispatching = false;
            emitMetrics();
            scheduleDispatch();
          },
          onError(error) {
            if (activeSegment?.id !== seg.id) return; // stale
            activeSegment = null;
            activeController = null;
            dispatching = false;
            emitSession(sessionError(sessionId, error.message, seg.id));
            emitMetrics();
            // Continue dispatching — one segment error should not kill the session
            scheduleDispatch();
          },
        },
        defaultStreamOptions
      );

      // Controller is only useful if segment is still active
      if (activeSegment?.id === seg.id) {
        activeController = controller;
      }
    } catch (err: unknown) {
      // generateSpeechStream itself threw (setup failure)
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
      flushResolve?.();
      flushResolve = null;
    } else if (state === 'active' || state === 'draining') {
      setState('idle');
      emitSession(sessionIdle(sessionId));
      emitMetrics();
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const engine: IncrementalStreamingTtsEngine = {
    get sessionId() {
      return sessionId;
    },

    get state() {
      return state;
    },

    // ------- pushText -------
    pushText(text: string): void {
      if (state === 'destroyed') {
        throw new Error('Cannot pushText on a destroyed engine.');
      }
      if (state === 'cancelled') {
        setState('idle');
      }

      textBuffer += text;

      if (state === 'idle') {
        setState('active');
        emitSession(sessionStarted(sessionId));
      }

      resetWaitTimer();
      resetDebounceTimer();
    },

    // ------- commit -------
    commit(_opts?: CommitOptions): void {
      if (state === 'destroyed') {
        throw new Error('Cannot commit on a destroyed engine.');
      }

      clearTimers();
      if (textBuffer.length === 0) return;

      // Force-commit entire buffer
      const boundaries = detectBoundaries(textBuffer, segPolicy, {
        forced: true,
      });
      for (const b of boundaries) {
        enqueueText(b.text);
      }
      textBuffer = '';
      scheduleDispatch();
    },

    // ------- flush -------
    async flush(): Promise<void> {
      if (state === 'destroyed') {
        throw new Error('Cannot flush a destroyed engine.');
      }

      clearTimers();

      // Commit any remaining buffer
      if (textBuffer.length > 0) {
        const boundaries = detectBoundaries(textBuffer, segPolicy, {
          forced: true,
        });
        for (const b of boundaries) {
          enqueueText(b.text);
        }
        textBuffer = '';
      }

      // Nothing to process → immediate
      if (queue.length === 0 && activeSegment === null) {
        if (state !== 'idle') {
          setState('idle');
          emitSession(sessionIdle(sessionId));
          emitMetrics();
        }
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
    },

    // ------- cancel -------
    async cancel(opts?: CancelOptions): Promise<void> {
      if (state === 'destroyed') return;

      const scope = opts?.scope ?? 'all';
      clearTimers();

      let droppedCount = 0;

      // Cancel queued segments
      if (scope === 'all' || scope === 'queued') {
        for (const seg of queue) {
          emitSegment(segmentDropped(sessionId, seg.id, 'cancelled'));
          droppedCount++;
          totalDropped++;
        }
        queue.length = 0;
        textBuffer = '';
      }

      // Cancel active segment
      if ((scope === 'all' || scope === 'active') && activeController) {
        try {
          await activeController.cancel();
        } catch {
          // ignore — synthesis may already have ended
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

      // Resolve pending flush
      if (flushResolve) {
        flushing = false;
        flushResolve();
        flushResolve = null;
      }

      emitMetrics();
    },

    // ------- getMetrics -------
    getMetrics(): IncrementalMetrics {
      return buildMetrics();
    },

    // ------- destroy -------
    async destroy(): Promise<void> {
      if (state === 'destroyed') return;

      clearTimers();
      queue.length = 0;
      textBuffer = '';

      if (activeController) {
        try {
          await activeController.cancel();
        } catch {
          // ignore
        }
        activeController = null;
        activeSegment = null;
      }

      if (flushResolve) {
        flushing = false;
        flushResolve();
        flushResolve = null;
      }

      setState('destroyed');
    },
  };

  return engine;
}
