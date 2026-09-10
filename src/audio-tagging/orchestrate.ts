import SherpaOnnx, {
  type AudioTaggingProcessNativeResult,
} from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { segmentOfflineBuffer } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import type { SegmentMeta } from '../segmentbuffer/types';
import {
  AudioTaggingErrorCode,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  type AudioTaggingEvent,
  type AudioTaggingResult,
  type AudioTaggingSegmentEvent,
  type AudioTaggingTagOptions,
  type SegmentedAudioTaggingResult,
} from './types';

export function collectSpeechSpans(segments: SegmentMeta[]): SegmentMeta[] {
  return segments.filter(
    (seg) =>
      seg.kind === 'speech' &&
      Number.isFinite(seg.startSample) &&
      Number.isFinite(seg.endSample) &&
      seg.endSample > seg.startSample
  );
}

export function spanDurationMs(span: SegmentMeta): number {
  if (span.durationMs != null && span.durationMs > 0) {
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

export function normalizeAudioTaggingNativeResult(
  res: AudioTaggingProcessNativeResult | null | undefined,
  fallbackTopK: number
): AudioTaggingResult {
  const events: AudioTaggingEvent[] = [];
  const raw = res?.events;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item == null || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name : '';
      const index =
        typeof item.index === 'number' && Number.isFinite(item.index)
          ? item.index
          : 0;
      const prob =
        typeof item.prob === 'number' && Number.isFinite(item.prob)
          ? item.prob
          : 0;
      events.push({ name, index, prob });
    }
  }
  const primary = events.length > 0 ? events[0] : undefined;
  return {
    events,
    ...(primary !== undefined ? { primary } : {}),
    audioDuration:
      typeof res?.audioDuration === 'number' ? res.audioDuration : 0,
    elapsedMs: typeof res?.elapsedMs === 'number' ? res.elapsedMs : 0,
    topK: typeof res?.topK === 'number' ? res.topK : fallbackTopK,
  };
}

export async function runOfflineAudioTaggingSegmentation(
  instanceId: string,
  audioIn: OfflineAudioBufferIdSource,
  options?: AudioTaggingTagOptions
): Promise<SegmentedAudioTaggingResult> {
  const audioBufferId = resolvePipelineAudioBufferId(audioIn);
  if (typeof audioBufferId !== 'string' || !audioBufferId.startsWith('off_')) {
    throw new Error(
      `${
        AudioTaggingErrorCode.INVALID_ARGUMENT
      }: expected an offline audio buffer (off_...), got ${String(
        audioBufferId
      )}`
    );
  }

  const segmentation = validateSegmentationConfig({
    mode: options?.segmentation?.mode,
    policy: options?.segmentation?.policy,
    featureName: 'audio tagging',
    domain: 'speech',
    supportsManual: false,
    defaultPolicy: DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
    supportedEvaluators: ['speech_energy_silence', 'continuous_frames'],
  });

  const targetSegmentBufferId = options?.targetSegmentBuffer
    ? resolveOfflineSegmentBufferId(options.targetSegmentBuffer)
    : null;

  const topK =
    options?.topK !== undefined && Number.isFinite(options.topK)
      ? options.topK
      : null;
  const fallbackTopK = topK ?? 5;

  const t0 = Date.now();
  const segRef = await segmentOfflineBuffer(
    audioBufferId,
    segmentation.policy!
  );

  let stagingLiveBufferId: string | null = null;
  try {
    const rawSegments = await getOfflineSegmentBufferSegments(
      segRef.segmentBufferId
    );
    const spans = collectSpeechSpans(rawSegments);

    if (targetSegmentBufferId != null) {
      const staging = await createLiveSegmentBuffer({
        sourceAudioBufferId: audioBufferId,
        spooling: { mode: 'on' },
      });
      stagingLiveBufferId = staging.bufferId;
    }

    const segments: AudioTaggingSegmentEvent[] = [];

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const durationMs = spanDurationMs(span);
      const sampleRate = span.sampleRate > 0 ? span.sampleRate : 16000;
      const startTime = span.startSample / sampleRate;
      const endTime = span.endSample / sampleRate;

      options?.onProgress?.({
        currentSegment: i,
        totalSegments: spans.length,
        fraction: spans.length > 0 ? i / spans.length : 1,
        currentSegmentDurationMs: durationMs,
        elapsedMs: Date.now() - t0,
      });

      const nativeRes = await SherpaOnnx.tagAudioOffline(
        instanceId,
        audioBufferId,
        topK,
        span.startSample,
        span.endSample
      );
      const result = normalizeAudioTaggingNativeResult(nativeRes, fallbackTopK);

      const event: AudioTaggingSegmentEvent = {
        segmentIndex: i,
        totalSegments: spans.length,
        startTime,
        endTime,
        durationMs,
        result,
      };
      segments.push(event);
      options?.onSegment?.(event);

      if (stagingLiveBufferId != null) {
        await appendLiveSegment(stagingLiveBufferId, {
          kind: 'speech',
          sourceAudioBufferId: audioBufferId,
          startSample: span.startSample,
          endSample: span.endSample,
          sampleRate,
          durationMs,
          ...(span.confidence != null ? { confidence: span.confidence } : {}),
          payload: {
            source: 'audioTagging',
            ...(result.primary?.name != null
              ? { primaryName: result.primary.name }
              : {}),
            events: result.events.map((e) => ({
              name: e.name,
              index: e.index,
              prob: e.prob,
            })),
          },
        });
      }
    }

    if (stagingLiveBufferId != null && targetSegmentBufferId != null) {
      await finalizeLiveSegmentBuffer(stagingLiveBufferId);
      await populateOfflineSegmentBufferIfEmpty(
        targetSegmentBufferId,
        stagingLiveBufferId
      );
    }

    return {
      segments,
      totalSegments: spans.length,
      processingTimeMs: Date.now() - t0,
    };
  } finally {
    if (segRef?.segmentBufferId) {
      try {
        await releasePipelineSegmentBuffer(segRef.segmentBufferId);
      } catch {
        // Best-effort cleanup
      }
    }
    if (stagingLiveBufferId != null) {
      try {
        await releasePipelineSegmentBuffer(stagingLiveBufferId);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
