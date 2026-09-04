import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
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
import SherpaOnnx from '../NativeSherpaOnnx';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import {
  finalizeLiveSegmentBuffer,
  resolveLiveSegmentBufferId,
  subscribeLiveSegmentBufferEvents,
} from '../segmentbuffer';
import type {
  LiveSegmentBufferIdSource,
  LiveSegmentBufferRef,
  LiveSegmentBufferSegmentAppendedEvent,
  SidSpeechSegmentPayload,
} from '../segmentbuffer/types';
import type {
  SpeakerEmbeddingEngine,
  SpeakerEmbeddingManager,
} from '../speaker-embedding/types';
import type { SpeakerIdentificationPipelineHandle } from './streamingTypes';
import type {
  SidLiveLabeledSegmentEvent,
  SpeakerIdentificationLiveLabelOptions,
} from './types';

const DEFAULT_THRESHOLD = 0.5;

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

function mapAppendedEventToLabeled(
  event: LiveSegmentBufferSegmentAppendedEvent
): SidLiveLabeledSegmentEvent | null {
  if (event.kind !== 'speech') return null;
  const payload = event.payload as SidSpeechSegmentPayload | undefined;
  if (payload?.source !== 'sid') return null;

  const labeled: SidLiveLabeledSegmentEvent = {
    segmentIndex: event.segmentIndex,
    startSample: event.startSample,
    endSample: event.endSample,
    sampleRate: event.sampleRate,
    durationMs: event.durationMs,
    speakerName: payload.speakerName,
  };
  if (
    typeof event.confidence === 'number' &&
    Number.isFinite(event.confidence)
  ) {
    labeled.confidence = event.confidence;
  }
  return labeled;
}

function createSidPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId: string,
  segmentsOutId: string,
  onLabeled?: (event: SidLiveLabeledSegmentEvent) => void
): SpeakerIdentificationPipelineHandle {
  let unsubEvents: (() => void) | null = null;
  if (onLabeled) {
    unsubEvents = subscribeLiveSegmentBufferEvents(segmentsOutId, {
      onSegmentAppended: (event) => {
        const labeled = mapAppendedEventToLabeled(event);
        if (labeled) onLabeled(labeled);
      },
    });
  }

  let cleanedUp = false;
  const cleanup = async (flushFinal: boolean): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubEvents?.();
    unsubEvents = null;
    await detachSegmentationEngine(attachedEngineId, { flushFinal }).catch(
      () => undefined
    );
    await finalizeLiveSegmentBuffer(segmentsOutId).catch(() => undefined);
  };

  const rawCompleted = createStreamingPipelineCompletionPromise(pipelineId);
  const completed: Promise<StreamingPipelineCompletion> = rawCompleted.then(
    async (completion) => {
      await cleanup(completion.reason !== 'error');
      return completion;
    },
    async (err) => {
      await cleanup(false);
      throw err;
    }
  );

  return {
    instanceId,
    pipelineId,
    completed,
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
      await completed.catch(() => undefined);
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus(): Promise<StreamingPipelineStatus> {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

/**
 * Live overload for SID: attach speech segmentation to `audioIn`, label each
 * committed utterance into `segmentsOut` via a native OfflineLivePipelineWorker.
 *
 * Maintainer note: native drain — see docs/internal/live-overload.md §11.
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

  const segmentLiveBufferId = engineInfo.segmentBufferId;
  if (!segmentLiveBufferId) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw new Error(
      'SID_LABEL_FAILED: segmentation engine did not produce a segment buffer for speech domain'
    );
  }

  let pipelineId: string;
  try {
    const result =
      await SherpaOnnx.startSpeakerIdentificationOfflineLivePipeline(
        embeddingEngine.instanceId,
        manager.managerId,
        audioInId,
        segmentsOutId,
        {
          attachedSegmentationEngineId: attached.engineId,
          segmentLiveBufferId,
          threshold,
        }
      );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  return createSidPipelineHandle(
    embeddingEngine.instanceId,
    pipelineId,
    attached.engineId,
    segmentsOutId,
    options.onLabeled
  );
}
