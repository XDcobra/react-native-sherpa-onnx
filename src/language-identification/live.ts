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
import { LanguageIdErrorCode } from './types';
import type {
  LanguageChangedEvent,
  LanguageIdSegmentEvent,
  LanguageIdentificationLivePipelineOptions,
} from './types';
import type { LanguageIdentificationPipelineHandle } from './streamingTypes';

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

function assertLiveOptions(
  options: LanguageIdentificationLivePipelineOptions
): void {
  if (options?.onSegment != null && typeof options.onSegment !== 'function') {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: options.onSegment must be a function`
    );
  }
  if (
    options?.onLanguageChanged != null &&
    typeof options.onLanguageChanged !== 'function'
  ) {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: options.onLanguageChanged must be a function`
    );
  }
}

function mapTextSegmentToLanguageIdEvent(
  segment: Segment
): LanguageIdSegmentEvent | null {
  if (segment.domain !== 'text') return null;
  const textSeg = segment as TextSegment;
  const lang =
    (typeof textSeg.lang === 'string' && textSeg.lang.trim()) ||
    (typeof textSeg.text === 'string' ? textSeg.text.trim() : '');
  if (!lang) return null;

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
  const metaDuration =
    textSeg.meta &&
    typeof textSeg.meta === 'object' &&
    typeof (textSeg.meta as Record<string, unknown>).durationMs === 'number'
      ? ((textSeg.meta as Record<string, unknown>).durationMs as number)
      : undefined;
  const durationMs =
    typeof metaDuration === 'number' && Number.isFinite(metaDuration)
      ? metaDuration
      : Math.max(0, Math.round((endTime - startTime) * 1000));

  return {
    segmentIndex: textSeg.segmentIndex,
    startTime,
    endTime,
    durationMs,
    lang,
  };
}

function createLanguageIdPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId: string,
  textOut: LiveTextBufferIdSource,
  onSegment?: (event: LanguageIdSegmentEvent) => void,
  onLanguageChanged?: (event: LanguageChangedEvent) => void
): LanguageIdentificationPipelineHandle {
  let previousLang: string | null = null;
  let unsubEvents: (() => void) | null = null;

  if (onSegment || onLanguageChanged) {
    unsubEvents = subscribeLiveTextBufferEvents(textOut, {
      onSegment: (event) => {
        const mapped = mapTextSegmentToLanguageIdEvent(event.segment);
        if (!mapped) return;
        onSegment?.(mapped);
        if (
          onLanguageChanged &&
          (previousLang === null || mapped.lang !== previousLang)
        ) {
          onLanguageChanged({
            previousLang,
            currentLang: mapped.lang,
            timestamp: mapped.startTime,
            segmentIndex: mapped.segmentIndex,
          });
          previousLang = mapped.lang;
        } else if (previousLang === null) {
          previousLang = mapped.lang;
        }
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
 * Live overload for SLID: attach speech segmentation to `audioIn`, identify
 * language per committed utterance into `textOut` via a native OfflineLivePipelineWorker.
 *
 * Maintainer note: shared base contracts — see docs/internal/live-overload.md.
 * This does not call the STT live pipeline.
 */
export async function identifyLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: LanguageIdentificationLivePipelineOptions
): Promise<LanguageIdentificationPipelineHandle> {
  assertLiveOptions(options);

  if (!isLiveAudioSource(audioIn) || !isLiveTextSource(textOut)) {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: identify(liveAudio, liveText, options) requires live buffers. ` +
        'For offline identification use identify(OfflineAudio, options?).'
    );
  }

  if (
    options.targetSegmentBuffer != null &&
    !isLiveSegmentSource(options.targetSegmentBuffer)
  ) {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: options.targetSegmentBuffer must be a live segment buffer (seg_live_*)`
    );
  }

  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'spoken language identification',
    domain: 'speech',
    supportedEvaluators: ['speech_energy_silence', 'speech_vad_model'],
    segmentation: options.segmentation,
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
      `${LanguageIdErrorCode.IDENTIFY_FAILED}: segmentation engine did not produce a segment buffer for speech domain`
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startLanguageIdOfflineLivePipeline(
      instanceId,
      audioInId,
      textOutId,
      {
        attachedSegmentationEngineId: attached.engineId,
        segmentLiveBufferId,
        ...(targetSegmentLiveBufferId != null
          ? { targetSegmentLiveBufferId }
          : {}),
      }
    );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  return createLanguageIdPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId,
    textOut,
    options.onSegment,
    options.onLanguageChanged
  );
}
