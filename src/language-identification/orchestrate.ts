import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { segmentOfflineBuffer } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import {
  appendLiveSegment,
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import type {
  OfflineSegmentBufferIdSource,
  SegmentMeta,
} from '../segmentbuffer/types';
import {
  DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY,
  LanguageIdErrorCode,
  type LanguageIdLabelOptions,
  type LanguageIdSegmentEntry,
  type LanguageIdentificationOptions,
  type LanguageSwitchEntry,
  type LabelOfflineSegmentsResult,
  type SegmentedLanguageIdentificationResult,
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

export interface EvaluatedSpan {
  span: SegmentMeta;
  lang: string;
}

export function computeLanguageTimelineAndDistribution(
  evaluatedSpans: EvaluatedSpan[]
): {
  dominantLanguage: string;
  distribution: Record<string, number>;
  switches: LanguageSwitchEntry[];
  segments: LanguageIdSegmentEntry[];
} {
  const segments: LanguageIdSegmentEntry[] = [];
  const switches: LanguageSwitchEntry[] = [];
  const durationByLang: Record<string, number> = {};
  let totalSpeechDurationMs = 0;
  let previousLang: string | null = null;

  for (let i = 0; i < evaluatedSpans.length; i++) {
    const { span, lang } = evaluatedSpans[i]!;
    const sampleRate = span.sampleRate > 0 ? span.sampleRate : 16000;
    const startTime = span.startSample / sampleRate;
    const endTime = span.endSample / sampleRate;
    const durationMs = spanDurationMs(span);

    segments.push({
      segmentIndex: i,
      startTime,
      endTime,
      durationMs,
      lang,
    });

    if (lang && lang.trim().length > 0) {
      const cleanLang = lang.trim();
      durationByLang[cleanLang] = (durationByLang[cleanLang] ?? 0) + durationMs;
      totalSpeechDurationMs += durationMs;

      if (previousLang === null || cleanLang !== previousLang) {
        switches.push({
          timestamp: startTime,
          from: previousLang,
          to: cleanLang,
          segmentIndex: i,
        });
        previousLang = cleanLang;
      }
    }
  }

  let dominantLanguage = '';
  let maxDuration = -1;
  const distribution: Record<string, number> = {};

  if (totalSpeechDurationMs > 0) {
    for (const [langKey, dur] of Object.entries(durationByLang)) {
      if (dur > maxDuration) {
        maxDuration = dur;
        dominantLanguage = langKey;
      }
      distribution[langKey] =
        Math.round((dur / totalSpeechDurationMs) * 10000) / 10000;
    }
  }

  return {
    dominantLanguage,
    distribution,
    switches,
    segments,
  };
}

export async function runOfflineLanguageIdSegmentation(
  instanceId: string,
  audioIn: OfflineAudioBufferIdSource,
  options?: LanguageIdentificationOptions
): Promise<SegmentedLanguageIdentificationResult> {
  const audioBufferId = resolvePipelineAudioBufferId(audioIn);
  if (typeof audioBufferId !== 'string' || !audioBufferId.startsWith('off_')) {
    throw new Error(
      `${
        LanguageIdErrorCode.INVALID_ARGUMENT
      }: expected an offline audio buffer (off_...), got ${String(
        audioBufferId
      )}`
    );
  }

  const segmentation = validateSegmentationConfig({
    mode: options?.segmentation?.mode,
    policy: options?.segmentation?.policy,
    featureName: 'spoken language identification',
    domain: 'speech',
    supportsManual: false,
    defaultPolicy: DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY,
  });

  const targetSegmentBufferId = options?.targetSegmentBuffer
    ? resolveOfflineSegmentBufferId(options.targetSegmentBuffer)
    : null;

  const t0 = Date.now();
  const segRef = await segmentOfflineBuffer(
    audioBufferId,
    segmentation.policy!
  );

  const hasCallbacks =
    typeof options?.onProgress === 'function' ||
    typeof options?.onSegment === 'function' ||
    typeof options?.onLanguageChanged === 'function';

  // Fast-path: When no callbacks are registered, perform buffer-to-buffer labeling directly in native
  if (!hasCallbacks) {
    let tempTargetBufferId: string | null = null;
    try {
      const outBufferId =
        targetSegmentBufferId ??
        (tempTargetBufferId = (
          await createEmptyOfflineSegmentBuffer({
            sourceAudioBufferId: audioBufferId,
          })
        ).bufferId);

      const nativeRes = await SherpaOnnx.labelLanguageIdOfflineSegments(
        instanceId,
        audioBufferId,
        segRef.segmentBufferId,
        outBufferId
      );

      return {
        dominantLanguage: nativeRes.dominantLanguage,
        distribution: nativeRes.distribution as Record<string, number>,
        switches: nativeRes.switches,
        segments: nativeRes.segments,
        totalSegments: nativeRes.labeledCount,
        processingTimeMs: Date.now() - t0,
      };
    } finally {
      if (tempTargetBufferId != null) {
        try {
          await releasePipelineSegmentBuffer(tempTargetBufferId);
        } catch {
          // Best-effort cleanup
        }
      }
      if (segRef?.segmentBufferId) {
        try {
          await releasePipelineSegmentBuffer(segRef.segmentBufferId);
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

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

    const evaluatedSpans: EvaluatedSpan[] = [];
    let previousLang: string | null = null;

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

      const res = await SherpaOnnx.identifyLanguageOffline(
        instanceId,
        audioBufferId,
        span.startSample,
        span.endSample
      );
      const lang = typeof res.lang === 'string' ? res.lang.trim() : '';

      evaluatedSpans.push({ span, lang });

      options?.onSegment?.({
        segmentIndex: i,
        totalSegments: spans.length,
        startTime,
        endTime,
        durationMs,
        lang,
      });

      if (lang && (previousLang === null || lang !== previousLang)) {
        options?.onLanguageChanged?.({
          previousLang,
          currentLang: lang,
          timestamp: startTime,
          segmentIndex: i,
        });
        previousLang = lang;
      }

      if (stagingLiveBufferId != null) {
        await appendLiveSegment(stagingLiveBufferId, {
          kind: 'speech',
          sourceAudioBufferId: audioBufferId,
          startSample: span.startSample,
          endSample: span.endSample,
          sampleRate,
          durationMs,
          ...(span.confidence != null ? { confidence: span.confidence } : {}),
          payload: { source: 'languageId', lang },
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

    const stats = computeLanguageTimelineAndDistribution(evaluatedSpans);

    return {
      dominantLanguage: stats.dominantLanguage,
      distribution: stats.distribution,
      switches: stats.switches,
      segments: stats.segments,
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

export async function runOfflineLanguageIdLabeling(
  instanceId: string,
  audioIn: OfflineAudioBufferIdSource,
  segmentsIn: OfflineSegmentBufferIdSource,
  segmentsOut: OfflineSegmentBufferIdSource,
  options?: LanguageIdLabelOptions
): Promise<LabelOfflineSegmentsResult> {
  const audioBufferId = resolvePipelineAudioBufferId(audioIn);
  if (typeof audioBufferId !== 'string' || !audioBufferId.startsWith('off_')) {
    throw new Error(
      `${
        LanguageIdErrorCode.INVALID_ARGUMENT
      }: expected an offline audio buffer (off_...), got ${String(
        audioBufferId
      )}`
    );
  }

  const segmentsInId = resolveOfflineSegmentBufferId(segmentsIn);
  const segmentsOutId = resolveOfflineSegmentBufferId(segmentsOut);

  const hasCallbacks =
    typeof options?.onProgress === 'function' ||
    typeof options?.onSegment === 'function' ||
    typeof options?.onLanguageChanged === 'function';

  // Fast-path: When no callbacks are registered, perform buffer-to-buffer labeling directly in native
  if (!hasCallbacks) {
    const nativeRes = await SherpaOnnx.labelLanguageIdOfflineSegments(
      instanceId,
      audioBufferId,
      segmentsInId,
      segmentsOutId
    );
    return {
      labeledCount: nativeRes.labeledCount,
      dominantLanguage: nativeRes.dominantLanguage,
      distribution: nativeRes.distribution as Record<string, number>,
      switches: nativeRes.switches,
    };
  }

  const rawSegments = await getOfflineSegmentBufferSegments(segmentsInId);
  const spans = collectSpeechSpans(rawSegments);

  if (spans.length === 0) {
    return {
      labeledCount: 0,
      dominantLanguage: '',
      distribution: {},
      switches: [],
    };
  }

  const t0 = Date.now();
  let stagingLiveBufferId: string | null = null;

  try {
    const staging = await createLiveSegmentBuffer({
      sourceAudioBufferId: audioBufferId,
      spooling: { mode: 'on' },
    });
    stagingLiveBufferId = staging.bufferId;

    const evaluatedSpans: EvaluatedSpan[] = [];
    let previousLang: string | null = null;

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const durationMs = spanDurationMs(span);
      const sampleRate = span.sampleRate > 0 ? span.sampleRate : 16000;
      const startTime = span.startSample / sampleRate;
      const endTime = span.endSample / sampleRate;

      options?.onProgress?.({
        currentSegment: i,
        totalSegments: spans.length,
        fraction: i / spans.length,
        currentSegmentDurationMs: durationMs,
        elapsedMs: Date.now() - t0,
      });

      const res = await SherpaOnnx.identifyLanguageOffline(
        instanceId,
        audioBufferId,
        span.startSample,
        span.endSample
      );
      const lang = typeof res.lang === 'string' ? res.lang.trim() : '';

      evaluatedSpans.push({ span, lang });

      await appendLiveSegment(stagingLiveBufferId, {
        kind: 'speech',
        sourceAudioBufferId: audioBufferId,
        startSample: span.startSample,
        endSample: span.endSample,
        sampleRate,
        durationMs,
        ...(span.confidence != null ? { confidence: span.confidence } : {}),
        payload: { source: 'languageId', lang },
      });

      options?.onSegment?.({
        segmentIndex: i,
        totalSegments: spans.length,
        startTime,
        endTime,
        durationMs,
        lang,
      });

      if (lang && (previousLang === null || lang !== previousLang)) {
        options?.onLanguageChanged?.({
          previousLang,
          currentLang: lang,
          timestamp: startTime,
          segmentIndex: i,
        });
        previousLang = lang;
      }
    }

    await finalizeLiveSegmentBuffer(stagingLiveBufferId);
    await populateOfflineSegmentBufferIfEmpty(
      segmentsOutId,
      stagingLiveBufferId
    );

    const stats = computeLanguageTimelineAndDistribution(evaluatedSpans);

    return {
      labeledCount: spans.length,
      dominantLanguage: stats.dominantLanguage,
      distribution: stats.distribution,
      switches: stats.switches,
    };
  } finally {
    if (stagingLiveBufferId != null) {
      try {
        await releasePipelineSegmentBuffer(stagingLiveBufferId);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
