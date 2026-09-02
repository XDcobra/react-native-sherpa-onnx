import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import {
  appendLiveSegment,
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
import { acquireSpeakerEmbeddingEngine } from '../speaker-embedding/engineCache';
import { createSpeakerEmbeddingManager } from '../speaker-embedding/manager';
import type {
  IdentifyResult,
  LabelOfflineSegmentsResult,
  SpeakerIdentificationEngine,
  SpeakerIdentificationOptions,
  SpeakerIdentificationThresholdOptions,
} from './types';

export type {
  IdentifyResult,
  LabelOfflineSegmentsResult,
  SpeakerIdentificationEngine,
  SpeakerIdentificationOptions,
  SpeakerIdentificationThresholdOptions,
} from './types';

const DEFAULT_THRESHOLD = 0.5;

function resolveThreshold(
  options?: SpeakerIdentificationThresholdOptions
): number {
  const t = options?.threshold;
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD;
}

/** Non-empty speech spans from an offline segment buffer (skips alignment / empty ranges). */
function collectSpeechSpans(segments: SegmentMeta[]): SegmentMeta[] {
  return segments.filter(
    (seg) =>
      seg.kind === 'speech' &&
      Number.isFinite(seg.startSample) &&
      Number.isFinite(seg.endSample) &&
      seg.endSample > seg.startSample
  );
}

/**
 * Create a Speaker Identification engine on the shared embedding extractor +
 * named-speaker manager. The extractor is ref-counted so future diarization
 * can share the same model weights via `acquireSpeakerEmbeddingEngine`.
 */
export async function createSpeakerIdentification(
  options: SpeakerIdentificationOptions
): Promise<SpeakerIdentificationEngine> {
  const engine = await acquireSpeakerEmbeddingEngine(options);
  const manager = await createSpeakerEmbeddingManager(engine.dim);

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Speaker identification instance ${engine.instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return engine.instanceId;
    },
    get managerId() {
      return manager.managerId;
    },
    get dim() {
      return engine.dim;
    },
    async enroll(
      name: string,
      audio: OfflineAudioBufferIdSource | OfflineAudioBufferIdSource[]
    ): Promise<void> {
      guard();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error('enroll() requires a non-empty speaker name');
      }
      const buffers = Array.isArray(audio) ? audio : [audio];
      if (buffers.length === 0) {
        throw new Error('enroll() requires at least one audio buffer');
      }
      const embeddings: Float32Array[] = [];
      for (const buffer of buffers) {
        embeddings.push(await engine.extractFromOfflineAudio(buffer));
      }
      const ok = await manager.add(trimmed, embeddings);
      if (!ok) {
        throw new Error(
          `Failed to enroll speaker '${trimmed}' (name may already exist)`
        );
      }
    },
    async enrollOfflineSegments(
      name: string,
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource
    ): Promise<void> {
      guard();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error(
          'enrollOfflineSegments() requires a non-empty speaker name'
        );
      }
      resolvePipelineAudioBufferId(audioIn);
      resolveOfflineSegmentBufferId(segmentsIn);
      const spans = collectSpeechSpans(
        await getOfflineSegmentBufferSegments(segmentsIn)
      );
      if (spans.length === 0) {
        throw new Error(
          'enrollOfflineSegments() requires at least one non-empty speech span'
        );
      }
      const embeddings: Float32Array[] = [];
      for (const span of spans) {
        embeddings.push(
          await engine.extractFromOfflineAudio(audioIn, {
            startSample: span.startSample,
            endSample: span.endSample,
          })
        );
      }
      const ok = await manager.add(trimmed, embeddings);
      if (!ok) {
        throw new Error(
          `Failed to enroll speaker '${trimmed}' (name may already exist)`
        );
      }
    },
    async identify(
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<IdentifyResult> {
      guard();
      const embedding = await engine.extractFromOfflineAudio(audio);
      const name = await manager.search(
        embedding,
        resolveThreshold(thresholdOptions)
      );
      const trimmed = name.trim();
      return { name: trimmed.length > 0 ? trimmed : null };
    },
    async labelOfflineSegments(
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource,
      segmentsOut: OfflineSegmentBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<LabelOfflineSegmentsResult> {
      guard();
      const audioBufferId = resolvePipelineAudioBufferId(audioIn);
      resolveOfflineSegmentBufferId(segmentsIn);
      resolveOfflineSegmentBufferId(segmentsOut);
      const threshold = resolveThreshold(thresholdOptions);
      const spans = collectSpeechSpans(
        await getOfflineSegmentBufferSegments(segmentsIn)
      );

      let labeledCount = 0;
      let unknownCount = 0;
      let stagingLiveBufferId: string | null = null;

      try {
        const staging = await createLiveSegmentBuffer({
          sourceAudioBufferId: audioBufferId,
          spooling: { mode: 'on' },
        });
        stagingLiveBufferId = staging.bufferId;

        for (const span of spans) {
          const embedding = await engine.extractFromOfflineAudio(audioIn, {
            startSample: span.startSample,
            endSample: span.endSample,
          });
          const rawName = await manager.search(embedding, threshold);
          const trimmed = rawName.trim();
          const speakerName = trimmed.length > 0 ? trimmed : null;
          if (speakerName == null) {
            unknownCount += 1;
          } else {
            labeledCount += 1;
          }

          const sampleRate = span.sampleRate;
          const durationMs =
            typeof span.durationMs === 'number' &&
            Number.isFinite(span.durationMs) &&
            span.durationMs > 0
              ? span.durationMs
              : sampleRate > 0
              ? Math.round(
                  ((span.endSample - span.startSample) * 1000) / sampleRate
                )
              : 0;

          await appendLiveSegment(stagingLiveBufferId, {
            kind: 'speech',
            sourceAudioBufferId: audioBufferId,
            startSample: span.startSample,
            endSample: span.endSample,
            sampleRate,
            durationMs,
            ...(span.confidence != null ? { confidence: span.confidence } : {}),
            payload: { source: 'sid', speakerName },
          });
        }

        await finalizeLiveSegmentBuffer(stagingLiveBufferId);
        await populateOfflineSegmentBufferIfEmpty(
          segmentsOut,
          stagingLiveBufferId
        );
      } finally {
        if (stagingLiveBufferId != null) {
          try {
            await releasePipelineSegmentBuffer(stagingLiveBufferId);
          } catch {
            // Best-effort cleanup of staging live buffer.
          }
        }
      }

      return { labeledCount, unknownCount };
    },
    async verify(
      name: string,
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<boolean> {
      guard();
      const embedding = await engine.extractFromOfflineAudio(audio);
      return manager.verify(
        name,
        embedding,
        resolveThreshold(thresholdOptions)
      );
    },
    async removeSpeaker(name: string): Promise<boolean> {
      guard();
      return manager.remove(name);
    },
    async listSpeakers(): Promise<string[]> {
      guard();
      return manager.listSpeakers();
    },
    async contains(name: string): Promise<boolean> {
      guard();
      return manager.contains(name);
    },
    async numSpeakers(): Promise<number> {
      guard();
      return manager.numSpeakers();
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await manager.destroy();
      await engine.destroy();
    },
  };
}
