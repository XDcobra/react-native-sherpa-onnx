import type {
  IncrementalStreamingTtsOptions,
  IncrementalStreamingTtsEngine,
} from './types';
import { createStreamingTTS } from '../streaming';
import { createEngine } from './engine';

/**
 * Create an incremental-streaming TTS engine.
 *
 * Accepts progressive text pushes (`pushText`) and segments/queues them
 * automatically, dispatching one segment at a time to the underlying
 * streaming engine. Defaults match createStreamingTTS behavior.
 *
 * @example
 * ```ts
 * const engine = await createIncrementalStreamingTTS({
 *   source: { engineOptions: { modelPath: { type: 'asset', path: 'model' } } },
 *   // defaults: playback: false, emitChunks: true
 * });
 *
 * engine.pushText('Hello world. ');
 * engine.pushText('This is streaming TTS.');
 * await engine.flush();
 * await engine.destroy();
 * ```
 */
export async function createIncrementalStreamingTTS(
  options: IncrementalStreamingTtsOptions
): Promise<IncrementalStreamingTtsEngine> {
  let ownsEngine = false;

  let streamingEngine;
  if ('engine' in options.source) {
    streamingEngine = options.source.engine;
  } else {
    streamingEngine = await createStreamingTTS(options.source.engineOptions);
    ownsEngine = true;
  }

  const engine = createEngine(streamingEngine, options);

  // Wrap destroy to also shut down the streaming engine if we created it
  if (ownsEngine) {
    const originalDestroy = engine.destroy.bind(engine);
    (engine as { destroy: typeof engine.destroy }).destroy = async () => {
      await originalDestroy();
      await streamingEngine.destroy();
    };
  }

  return engine;
}

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { createEngine } from './engine';
export { detectBoundaries, resolveSegmentationPolicy } from './segmenter';
export { applyEnqueuePolicy, resolveQueuePolicy } from './policies';

export type {
  // Engine
  IncrementalStreamingTtsEngine,
  IncrementalStreamingTtsOptions,
  IncrementalStreamingTtsSource,
  IncrementalMetrics,
  // IDs & state
  SessionId,
  SegmentId,
  SessionState,
  // Policies
  SegmentationPolicy,
  QueuePolicy,
  QueueMode,
  OverflowStrategy,
  // Options
  CommitOptions,
  FlushOptions,
  CancelOptions,
  CancelScope,
  // Session events
  SessionEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionDrainingEvent,
  SessionCancelledEvent,
  SessionErrorEvent,
  // Segment events
  SegmentEvent,
  SegmentQueuedEvent,
  SegmentStartedEvent,
  SegmentEndedEvent,
  SegmentDroppedEvent,
  SegmentChunkEvent,
} from './types';

export type { ResolvedSegmentationPolicy, SegmentBoundary } from './segmenter';

export type {
  QueuedSegment,
  ResolvedQueuePolicy,
  EnqueueResult,
} from './policies';
