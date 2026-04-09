import type {
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamingTtsEngine,
} from './types';
import { createStreamingTTS } from '../streaming';
import { createEngine } from './engine';

/**
 * Create an incremental-streaming TTS engine (factory).
 *
 * Returns an `IncrementalStreamingTtsEngine` whose
 * `generateIncrementalSpeechStream()` method creates per-request controllers
 * for progressive text pushing, segmentation, and optional native playback.
 *
 * @example
 * ```ts
 * const engine = await createIncrementalStreamingTTS({
 *   source: { engineOptions: { modelPath: { type: 'asset', path: 'model' } } },
 * });
 *
 * const ctrl = engine.generateIncrementalSpeechStream(undefined, {
 *   onChunk: (c) => {
 *     // default: playback false, emitChunks true
 *   },
 *   onEnd: () => console.log('done'),
 * });
 * // Native playback instead: add third arg `{ playback: true, emitChunks: false }`
 * ctrl.pushText('Hello world. ');
 * ctrl.pushText('This is streaming TTS.');
 * await ctrl.flush();
 * await engine.destroy();
 * ```
 */
export async function createIncrementalStreamingTTS(
  options: IncrementalStreamingTtsFactoryOptions
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
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamingTtsSource,
  IncrementalMetrics,
  // Controllers
  IncrementalStreamController,
  IncrementalStreamFileController,
  // Handlers
  IncrementalStreamHandlers,
  IncrementalStreamToFileHandlers,
  // Per-request options
  IncrementalRequestOptions,
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
