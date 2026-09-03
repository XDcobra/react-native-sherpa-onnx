import {
  createOfflineAudioBufferFromSamples,
  getLiveAudioBufferSamplesSlice,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import type {
  LiveAudioBufferIdSource,
  LiveAudioBufferRef,
  PipelineAudioBufferIdSource,
} from '../audiobuffer/types';
import type {
  StreamingPipelineCompletion,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import {
  appendLiveSegment,
  finalizeLiveSegmentBuffer,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  resolveLiveSegmentBufferId,
} from '../segmentbuffer';
import type {
  LiveSegmentBufferIdSource,
  LiveSegmentBufferRef,
  SegmentMeta,
} from '../segmentbuffer/types';
import type {
  SpeakerEmbeddingEngine,
  SpeakerEmbeddingManager,
} from '../speaker-embedding/types';
import type { SpeakerIdentificationPipelineHandle } from './streamingTypes';
import type { SpeakerIdentificationLiveLabelOptions } from './types';

const DEFAULT_THRESHOLD = 0.5;
const POLL_INTERVAL_MS = 50;

let sidLivePipelineCounter = 0;

function resolveThreshold(
  options?: SpeakerIdentificationLiveLabelOptions
): number {
  const t = options?.threshold;
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD;
}

function assertLiveLabelOptions(
  options: SpeakerIdentificationLiveLabelOptions
): void {
  if (options?.onLabeled != null && typeof options.onLabeled !== 'function') {
    throw new Error(
      'SID_INVALID_OPTIONS: options.onLabeled must be a function'
    );
  }
}

export function isLiveAudioSource(
  buffer: unknown
): buffer is LiveAudioBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveAudioBufferRef).info === 'object' &&
    (buffer as LiveAudioBufferRef).info?.kind === 'livePcmBuffer'
  ) {
    return true;
  }
  return false;
}

export function isLiveSegmentSource(
  buffer: unknown
): buffer is LiveSegmentBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('seg_live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveSegmentBufferRef).info === 'object' &&
    (buffer as LiveSegmentBufferRef).info?.kind === 'liveSegmentBuffer'
  ) {
    return true;
  }
  return false;
}

function spanDurationMs(span: SegmentMeta): number {
  if (
    typeof span.durationMs === 'number' &&
    Number.isFinite(span.durationMs) &&
    span.durationMs > 0
  ) {
    return span.durationMs;
  }
  const sampleRate = span.sampleRate;
  if (sampleRate > 0) {
    return Math.round(
      ((span.endSample - span.startSample) * 1000) / sampleRate
    );
  }
  return 0;
}

function isNonEmptySpeechSpan(seg: SegmentMeta): boolean {
  return (
    seg.kind === 'speech' &&
    Number.isFinite(seg.startSample) &&
    Number.isFinite(seg.endSample) &&
    seg.endSample > seg.startSample
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PipelineState = {
  isRunning: boolean;
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  error: string | null;
  cursor: number;
  segmentIndex: number;
  stopRequested: boolean;
  inputFinishedSeen: boolean;
  finalizedOut: boolean;
  detached: boolean;
};

/**
 * Live overload for SID: attach speech segmentation to `audioIn`, label each
 * committed utterance into `segmentsOut`, return a pipeline handle.
 *
 * Maintainer note: JS orchestration — see docs/internal/live-overload.md §11.
 */
export async function labelLiveSegments(
  embeddingEngine: SpeakerEmbeddingEngine,
  manager: SpeakerEmbeddingManager,
  audioIn: LiveAudioBufferIdSource,
  segmentsOut: LiveSegmentBufferIdSource,
  options: SpeakerIdentificationLiveLabelOptions
): Promise<SpeakerIdentificationPipelineHandle> {
  assertLiveLabelOptions(options);

  if (!isLiveAudioSource(audioIn) || !isLiveSegmentSource(segmentsOut)) {
    throw new Error(
      'SID_INVALID_ARGUMENT: labelLiveSegments() requires (LiveAudio, LiveSegment, options). ' +
        'For offline labeling use labelOfflineSegments(OfflineAudio, OfflineSegment, OfflineSegment, options?).'
    );
  }

  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline speaker identification',
    domain: 'speech',
    supportedEvaluators: ['speech_energy_silence', 'speech_vad_model'],
    segmentation: options.segmentation,
  });

  const audioInId = resolvePipelineAudioBufferId(
    audioIn as PipelineAudioBufferIdSource
  );
  const segmentsOutId = resolveLiveSegmentBufferId(segmentsOut);
  const threshold = resolveThreshold(options);
  const pipelineId = `sid_live_${++sidLivePipelineCounter}`;

  const attached = await attachSegmentationEngine(
    audioIn as PipelineAudioBufferIdSource,
    { policy }
  );

  let engineInfo: Awaited<ReturnType<typeof getSegmentationEngineInfo>>;
  try {
    engineInfo = await getSegmentationEngineInfo(attached.engineId);
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const internalSegBufId = engineInfo.segmentBufferId;
  if (!internalSegBufId) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw new Error(
      'SID_LABEL_FAILED: segmentation engine did not produce a segment buffer for speech domain'
    );
  }

  const state: PipelineState = {
    isRunning: true,
    chunksProcessed: 0,
    unitsRead: 0,
    unitsWritten: 0,
    error: null,
    cursor: 0,
    segmentIndex: 0,
    stopRequested: false,
    inputFinishedSeen: false,
    finalizedOut: false,
    detached: false,
  };

  let settleCompletion: ((value: StreamingPipelineCompletion) => void) | null =
    null;
  let rejectCompletion: ((reason?: unknown) => void) | null = null;
  let settled = false;

  const completed = new Promise<StreamingPipelineCompletion>(
    (resolve, reject) => {
      settleCompletion = resolve;
      rejectCompletion = reject;
    }
  );

  const toCompletion = (
    reason: StreamingPipelineCompletion['reason']
  ): StreamingPipelineCompletion => ({
    pipelineId,
    reason,
    chunksProcessed: state.chunksProcessed,
    unitsRead: state.unitsRead,
    unitsWritten: state.unitsWritten,
    error: state.error,
  });

  const settle = (reason: StreamingPipelineCompletion['reason']): void => {
    if (settled) return;
    settled = true;
    state.isRunning = false;
    const completion = toCompletion(reason);
    if (reason === 'error') {
      const error = Object.assign(
        new Error(
          state.error ??
            `Speaker identification live pipeline ${pipelineId} failed`
        ),
        {
          code: 'STREAMING_PIPELINE_ERROR',
          completion,
        }
      );
      rejectCompletion?.(error);
    } else {
      settleCompletion?.(completion);
    }
  };

  const detachIfNeeded = async (flushFinal: boolean): Promise<void> => {
    if (state.detached) return;
    state.detached = true;
    await detachSegmentationEngine(attached.engineId, { flushFinal }).catch(
      () => undefined
    );
  };

  const finalizeOutIfNeeded = async (): Promise<void> => {
    if (state.finalizedOut) return;
    state.finalizedOut = true;
    await finalizeLiveSegmentBuffer(segmentsOutId).catch(() => undefined);
  };

  const labelSpan = async (span: SegmentMeta): Promise<void> => {
    const startSample = Math.max(0, Math.floor(span.startSample));
    const endSample = Math.max(startSample, Math.floor(span.endSample));
    const frameCount = endSample - startSample;
    const sampleRate = span.sampleRate;
    const durationMs = spanDurationMs(span);

    const audioInfo = await getPipelineAudioBufferInfo(audioInId);
    const channelCount =
      'channelCount' in audioInfo && typeof audioInfo.channelCount === 'number'
        ? audioInfo.channelCount
        : 1;

    const samples =
      frameCount > 0
        ? getLiveAudioBufferSamplesSlice(audioInId, startSample, frameCount)
        : new Float32Array(0);

    state.unitsRead += frameCount;

    const temp = createOfflineAudioBufferFromSamples(
      samples,
      sampleRate > 0
        ? sampleRate
        : 'sampleRate' in audioInfo
        ? audioInfo.sampleRate
        : 16000,
      channelCount,
      { targetSampleRateHz: 0 }
    );

    let speakerName: string | null = null;
    try {
      const embedding = await embeddingEngine.extractFromOfflineAudio(temp);
      const rawName = await manager.search(embedding, threshold);
      const trimmed = rawName.trim();
      speakerName = trimmed.length > 0 ? trimmed : null;
    } finally {
      await releasePipelineAudioBuffer(temp.bufferId).catch(() => undefined);
    }

    await appendLiveSegment(segmentsOutId, {
      kind: 'speech',
      sourceAudioBufferId: audioInId,
      startSample,
      endSample,
      sampleRate,
      durationMs,
      ...(span.confidence != null ? { confidence: span.confidence } : {}),
      payload: { source: 'sid', speakerName },
    });

    state.unitsWritten += 1;
    state.chunksProcessed += 1;

    const event = {
      segmentIndex: state.segmentIndex,
      startSample,
      endSample,
      sampleRate,
      durationMs,
      speakerName,
      ...(span.confidence != null ? { confidence: span.confidence } : {}),
    };
    state.segmentIndex += 1;
    options.onLabeled?.(event);
  };

  let drainChain: Promise<void> = Promise.resolve();

  const drainNewSpans = (): Promise<void> => {
    const run = async (): Promise<void> => {
      const total = await getLiveSegmentBufferSegmentCount(internalSegBufId);
      if (total <= state.cursor) {
        return;
      }
      const batch = await getLiveSegmentBufferSegments(
        internalSegBufId,
        state.cursor,
        total - state.cursor
      );
      state.cursor += batch.length;

      for (const span of batch) {
        if (!isNonEmptySpeechSpan(span)) {
          continue;
        }
        await labelSpan(span);
      }
    };

    drainChain = drainChain.then(run, run);
    return drainChain;
  };

  let loopActive = true;

  const runLoop = async (): Promise<void> => {
    try {
      while (loopActive && !state.stopRequested) {
        await drainNewSpans();

        const info = await getPipelineAudioBufferInfo(audioInId);
        if (
          info.kind === 'livePcmBuffer' &&
          info.state === 'finished' &&
          !state.inputFinishedSeen
        ) {
          state.inputFinishedSeen = true;
          // Input finalized: flush final segmentation, drain tail, complete.
          await detachIfNeeded(true);
          await drainNewSpans();
          await finalizeOutIfNeeded();
          settle('completed');
          return;
        }

        if (state.stopRequested) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (state.stopRequested) {
        await detachIfNeeded(true);
        await drainNewSpans();
        await finalizeOutIfNeeded();
        settle('stopped');
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      await detachIfNeeded(false).catch(() => undefined);
      await finalizeOutIfNeeded().catch(() => undefined);
      settle('error');
    } finally {
      loopActive = false;
    }
  };

  // Kick off the poll loop without awaiting (handle returns immediately).
  Promise.resolve()
    .then(() => runLoop())
    .catch(() => undefined);

  const handle: SpeakerIdentificationPipelineHandle = {
    instanceId: embeddingEngine.instanceId,
    pipelineId,
    completed,
    async stop(): Promise<void> {
      if (settled) return;
      state.stopRequested = true;
      // Wait until the loop settles completed.
      await completed.catch(() => undefined);
    },
    async flush(): Promise<void> {
      if (settled || !state.isRunning) return;
      // Drain already-committed spans; tail utterance emits on stop/finalize.
      await drainNewSpans();
    },
    async reset(): Promise<void> {
      // Soft no-op for JS counters only; native segmentation reset is not exposed.
      // Matches OfflineLivePipelineWorker.reset() intentional no-op.
      if (settled || !state.isRunning) return;
      state.chunksProcessed = 0;
      state.unitsRead = 0;
      state.unitsWritten = 0;
      state.error = null;
    },
    async getStatus(): Promise<StreamingPipelineStatus> {
      return {
        pipelineId,
        isRunning: state.isRunning,
        chunksProcessed: state.chunksProcessed,
        unitsRead: state.unitsRead,
        unitsWritten: state.unitsWritten,
        error: state.error,
      };
    },
  };

  return handle;
}
