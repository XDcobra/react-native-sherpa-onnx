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
import type { TextSegment, Segment } from '../segment/segment';
import { resolveLiveSegmentBufferId } from '../segmentbuffer';
import type {
  LiveSegmentBufferIdSource,
  LiveSegmentBufferRef,
} from '../segmentbuffer/types';
import {
  resolvePipelineTextBufferId,
  subscribeLiveTextBufferEvents,
} from '../textbuffer';
import type {
  LiveTextBufferIdSource,
  LiveTextBufferRef,
  PipelineTextBufferIdSource,
} from '../textbuffer/types';
import type { AudioTaggingPipelineHandle } from './streamingTypes';
import {
  AudioTaggingErrorCode,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
} from './types';
import type {
  AudioTaggingEvent,
  AudioTaggingLivePipelineOptions,
  AudioTaggingLiveSegmentEvent,
  AudioTaggingResult,
} from './types';

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

export function isLiveTextSource(
  buffer: unknown
): buffer is LiveTextBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('txt_live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveTextBufferRef).info === 'object' &&
    (buffer as LiveTextBufferRef).info?.kind === 'liveTextBuffer'
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

function assertLiveOptions(options: AudioTaggingLivePipelineOptions): void {
  if (options?.onSegment != null && typeof options.onSegment !== 'function') {
    throw new Error(
      `${AudioTaggingErrorCode.INVALID_ARGUMENT}: options.onSegment must be a function`
    );
  }
}

function parseEventsFromMeta(meta: unknown): AudioTaggingEvent[] {
  if (meta == null || typeof meta !== 'object') return [];
  const raw = (meta as Record<string, unknown>).events;
  if (!Array.isArray(raw)) return [];
  const out: AudioTaggingEvent[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : '';
    const index =
      typeof rec.index === 'number' && Number.isFinite(rec.index)
        ? rec.index
        : -1;
    const prob =
      typeof rec.prob === 'number' && Number.isFinite(rec.prob) ? rec.prob : 0;
    if (!name) continue;
    out.push({ name, index, prob });
  }
  return out;
}

function mapTextSegmentToLiveEvent(
  segment: Segment
): AudioTaggingLiveSegmentEvent | null {
  if (segment.domain !== 'text') return null;
  const textSeg = segment as TextSegment;
  const primaryName =
    typeof textSeg.text === 'string' ? textSeg.text.trim() : '';
  if (!primaryName) return null;

  const timestamps = Array.isArray(textSeg.timestamps)
    ? textSeg.timestamps
    : [];
  const startTime =
    typeof timestamps[0] === 'number' && Number.isFinite(timestamps[0])
      ? timestamps[0]
      : 0;
  const endTime =
    typeof timestamps[1] === 'number' && Number.isFinite(timestamps[1])
      ? timestamps[1]
      : startTime;
  const meta =
    textSeg.meta && typeof textSeg.meta === 'object'
      ? (textSeg.meta as Record<string, unknown>)
      : {};
  const metaDuration =
    typeof meta.durationMs === 'number' ? meta.durationMs : undefined;
  const durationMs =
    typeof metaDuration === 'number' && Number.isFinite(metaDuration)
      ? metaDuration
      : Math.max(0, Math.round((endTime - startTime) * 1000));

  const events = parseEventsFromMeta(meta);
  const primary =
    events.find((e) => e.name === primaryName) ??
    events[0] ??
    ({ name: primaryName, index: -1, prob: 0 } as AudioTaggingEvent);

  const result: AudioTaggingResult = {
    events: events.length > 0 ? events : [primary],
    primary,
    audioDuration: durationMs / 1000,
    elapsedMs: 0,
    topK: events.length > 0 ? events.length : 1,
  };

  return {
    segmentIndex: textSeg.segmentIndex,
    startTime,
    endTime,
    durationMs,
    result,
  };
}

function createAudioTaggingPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId: string,
  textOut: LiveTextBufferIdSource,
  onSegment?: (event: AudioTaggingLiveSegmentEvent) => void
): AudioTaggingPipelineHandle {
  let unsubEvents: (() => void) | null = null;

  if (onSegment) {
    unsubEvents = subscribeLiveTextBufferEvents(textOut, {
      onSegment: (event) => {
        const mapped = mapTextSegmentToLiveEvent(event.segment);
        if (!mapped) return;
        onSegment(mapped);
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
 * Live overload for audio tagging: attach segmentation to `audioIn`, tag each
 * committed span into `textOut` via a native OfflineLivePipelineWorker.
 *
 * Maintainer note: shared base contracts — see docs/internal/live-overload.md.
 */
export async function tagLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: AudioTaggingLivePipelineOptions
): Promise<AudioTaggingPipelineHandle> {
  assertLiveOptions(options);

  if (!isLiveAudioSource(audioIn) || !isLiveTextSource(textOut)) {
    throw new Error(
      `${AudioTaggingErrorCode.INVALID_ARGUMENT}: tag(liveAudio, liveText, options) requires live buffers. ` +
        'For offline tagging use tag(OfflineAudio, options?).'
    );
  }

  if (
    options.targetSegmentBuffer != null &&
    !isLiveSegmentSource(options.targetSegmentBuffer)
  ) {
    throw new Error(
      `${AudioTaggingErrorCode.INVALID_ARGUMENT}: options.targetSegmentBuffer must be a live segment buffer (seg_live_*)`
    );
  }

  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'audio tagging',
    domain: 'speech',
    supportedEvaluators: ['speech_energy_silence', 'continuous_frames'],
    segmentation: {
      mode: options.segmentation?.mode ?? 'auto',
      policy:
        options.segmentation?.policy ??
        DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
    },
  });

  const audioInId = resolvePipelineAudioBufferId(
    audioIn as PipelineAudioBufferIdSource
  );
  const textOutId = resolvePipelineTextBufferId(
    textOut as PipelineTextBufferIdSource
  );
  const targetSegmentLiveBufferId = options.targetSegmentBuffer
    ? resolveLiveSegmentBufferId(options.targetSegmentBuffer)
    : null;

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
      `${AudioTaggingErrorCode.TAG_FAILED}: segmentation engine did not produce a segment buffer for speech domain`
    );
  }

  const topK =
    options.topK !== undefined && Number.isFinite(options.topK)
      ? options.topK
      : null;

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startAudioTaggingOfflineLivePipeline(
      instanceId,
      audioInId,
      textOutId,
      {
        attachedSegmentationEngineId: attached.engineId,
        segmentLiveBufferId,
        ...(targetSegmentLiveBufferId != null
          ? { targetSegmentLiveBufferId }
          : {}),
        ...(topK != null ? { topK } : {}),
      }
    );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  return createAudioTaggingPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId,
    textOut,
    options.onSegment
  );
}
