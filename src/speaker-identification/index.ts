import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
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
  LiveSegmentBufferIdSource,
  OfflineSegmentBufferIdSource,
  SegmentMeta,
} from '../segmentbuffer/types';
import { createSpeakerEmbeddingEngine } from '../speaker-embedding/engine';
import { createSpeakerEmbeddingManager } from '../speaker-embedding/manager';
import {
  buildSpeakerEmbeddingInitBridgeOptions,
  speakerEmbeddingEngineCacheKeyFromBridgeOptions,
} from '../speaker-embedding/speakerEmbeddingNativeBridge';
import { labelLiveSegments } from './live';
import { createSpeakerIdentificationProgressSession } from './progress';
import type {
  IdentifyResult,
  ImportEnrollmentsOptions,
  ImportEnrollmentsResult,
  LabelOfflineSegmentsResult,
  SpeakerEnrollmentBundle,
  SpeakerIdentificationEngine,
  SpeakerIdentificationLabelOptions,
  SpeakerIdentificationLiveLabelOptions,
  SpeakerIdentificationOptions,
  SpeakerIdentificationSegmentOptions,
  SpeakerIdentificationThresholdOptions,
  SpeakerIdentificationVerifyOptions,
  VerifyOfflineSegmentsResult,
} from './types';

export type {
  IdentifyResult,
  ImportEnrollmentsOptions,
  ImportEnrollmentsResult,
  LabelOfflineSegmentsResult,
  OrchestrationProgress,
  SidLabeledSegmentEvent,
  SidLiveLabeledSegmentEvent,
  SidVerifiedSegmentEvent,
  SpeakerEnrollmentBundle,
  SpeakerEnrollmentEntry,
  SpeakerIdentificationEngine,
  SpeakerIdentificationLabelOptions,
  SpeakerIdentificationLiveLabelOptions,
  SpeakerIdentificationOptions,
  SpeakerIdentificationSegmentOptions,
  SpeakerIdentificationThresholdOptions,
  SpeakerIdentificationVerifyOptions,
  VerifyOfflineSegmentsResult,
} from './types';

export type { SpeakerIdentificationPipelineHandle } from './streamingTypes';

// DX parity with other feature packages: detect / model types / error codes
// also live on `react-native-sherpa-onnx/speaker-embedding` (shared foundation).
export {
  detectSpeakerEmbeddingModel,
  SPEAKER_EMBEDDING_MODEL_TYPES,
  SpeakerEmbeddingErrorCode,
  assertSpeakerEmbeddingCustomConfig,
  resolveSpeakerEmbeddingCustomConfigPaths,
} from '../speaker-embedding';
export type {
  SpeakerEmbeddingCustomConfig,
  SpeakerEmbeddingCustomPathKey,
  SpeakerEmbeddingDetectResult,
  SpeakerEmbeddingModelType,
} from '../speaker-embedding';

const DEFAULT_THRESHOLD = 0.5;
const ENROLLMENT_BUNDLE_VERSION = 1 as const;

function resolveThreshold(
  options?: SpeakerIdentificationThresholdOptions
): number {
  const t = options?.threshold;
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD;
}

function numberArraysToEmbeddings(
  arrays: number[][],
  dim: number
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < arrays.length; i++) {
    const row = arrays[i]!;
    if (!Array.isArray(row) || row.length !== dim) {
      throw new Error(
        `SID_ENROLLMENT_BUNDLE_INVALID: embeddings[${i}] must be a number[] of length ${dim}`
      );
    }
    const embedding = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      const value = row[j]!;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `SID_ENROLLMENT_BUNDLE_INVALID: embeddings[${i}][${j}] must be a finite number`
        );
      }
      embedding[j] = value;
    }
    out.push(embedding);
  }
  return out;
}

/**
 * Enrollment identity is the embedding weights path only.
 * Engine cache keys also embed provider/numThreads — those must not block
 * reloading the same gallery after a threads/provider change.
 */
export function enrollmentModelIdentityFromKey(
  modelKey: string | undefined
): string {
  if (typeof modelKey !== 'string') {
    return '';
  }
  const trimmed = modelKey.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as { modelKey?: unknown };
    if (typeof parsed?.modelKey === 'string' && parsed.modelKey.trim()) {
      return parsed.modelKey.trim();
    }
  } catch {
    // Legacy / plain path fingerprints.
  }
  return trimmed;
}

function assertEnrollmentBundle(
  bundle: SpeakerEnrollmentBundle,
  expectedDim: number,
  expectedModelKey: string | undefined
): void {
  if (bundle == null || typeof bundle !== 'object') {
    throw new Error('SID_ENROLLMENT_BUNDLE_INVALID: bundle must be an object');
  }
  if (bundle.version !== ENROLLMENT_BUNDLE_VERSION) {
    throw new Error(
      `SID_ENROLLMENT_BUNDLE_INVALID: unsupported version ${String(
        (bundle as { version?: unknown }).version
      )} (expected ${ENROLLMENT_BUNDLE_VERSION})`
    );
  }
  if (typeof bundle.dim !== 'number' || !Number.isFinite(bundle.dim)) {
    throw new Error(
      'SID_ENROLLMENT_BUNDLE_INVALID: dim must be a finite number'
    );
  }
  if (bundle.dim !== expectedDim) {
    throw new Error(
      `SID_ENROLLMENT_DIM_MISMATCH: bundle dim ${bundle.dim} does not match manager dim ${expectedDim}`
    );
  }
  const bundleIdentity = enrollmentModelIdentityFromKey(bundle.modelKey);
  const expectedIdentity = enrollmentModelIdentityFromKey(expectedModelKey);
  if (
    bundleIdentity.length > 0 &&
    expectedIdentity.length > 0 &&
    bundleIdentity !== expectedIdentity
  ) {
    throw new Error(
      'SID_ENROLLMENT_MODEL_MISMATCH: bundle modelKey does not match this SID instance'
    );
  }
  if (!Array.isArray(bundle.speakers)) {
    throw new Error('SID_ENROLLMENT_BUNDLE_INVALID: speakers must be an array');
  }
}

function assertSegmentOptions(
  options?: SpeakerIdentificationSegmentOptions
): void {
  if (options?.onProgress != null && typeof options.onProgress !== 'function') {
    throw new Error(
      'SID_INVALID_OPTIONS: options.onProgress must be a function'
    );
  }
}

function assertLabelOptions(options?: SpeakerIdentificationLabelOptions): void {
  assertSegmentOptions(options);
  if (options?.onLabeled != null && typeof options.onLabeled !== 'function') {
    throw new Error(
      'SID_INVALID_OPTIONS: options.onLabeled must be a function'
    );
  }
}

function assertVerifyOptions(
  options?: SpeakerIdentificationVerifyOptions
): void {
  assertSegmentOptions(options);
  if (options?.onVerified != null && typeof options.onVerified !== 'function') {
    throw new Error(
      'SID_INVALID_OPTIONS: options.onVerified must be a function'
    );
  }
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
 * Expand `string | string[]` to one trimmed name per speech span.
 * List length must match `speechSpanCount`; a single string is repeated.
 */
function resolvePerSpanSpeakerNames(
  nameOrNames: string | string[],
  speechSpanCount: number,
  apiLabel: string
): string[] {
  if (Array.isArray(nameOrNames)) {
    if (nameOrNames.length !== speechSpanCount) {
      throw new Error(
        `${apiLabel}() name list length (${nameOrNames.length}) must match speech span count (${speechSpanCount})`
      );
    }
    const out: string[] = [];
    for (let i = 0; i < nameOrNames.length; i++) {
      const trimmed =
        typeof nameOrNames[i] === 'string' ? nameOrNames[i]!.trim() : '';
      if (trimmed.length === 0) {
        throw new Error(`${apiLabel}() names[${i}] must be a non-empty string`);
      }
      out.push(trimmed);
    }
    return out;
  }

  const trimmed = nameOrNames.trim();
  if (trimmed.length === 0) {
    throw new Error(`${apiLabel}() requires a non-empty speaker name`);
  }
  return Array.from({ length: speechSpanCount }, () => trimmed);
}

/**
 * Create a Speaker Identification engine on the shared embedding extractor +
 * named-speaker manager. Extractor ONNX weights are shared process-wide with
 * diarization via the C++ `SpeakerEmbeddingRunner` registry.
 * @throws {Error} `SPEAKER_EMBEDDING_INVALID_ARGUMENT` — custom model paths are incomplete or invalid.
 * @throws {Error} Native extractor init failed (`Speaker embedding initialization failed` / `SPEAKER_EMBEDDING_INIT_ERROR`).
 * @throws {Error} Native manager create failed (`Speaker embedding manager creation failed` / `SPEAKER_EMBEDDING_MANAGER_ERROR`).
 */
export async function createSpeakerIdentification(
  options: SpeakerIdentificationOptions
): Promise<SpeakerIdentificationEngine> {
  const bridgeOptions = await buildSpeakerEmbeddingInitBridgeOptions(options);
  const modelKey =
    speakerEmbeddingEngineCacheKeyFromBridgeOptions(bridgeOptions);
  const engine = await createSpeakerEmbeddingEngine(options);
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
      if (await manager.contains(trimmed)) {
        throw new Error(
          `Speaker '${trimmed}' is already enrolled. Remove them first or choose another name.`
        );
      }
      const buffers = Array.isArray(audio) ? audio : [audio];
      if (buffers.length === 0) {
        throw new Error('enroll() requires at least one audio buffer');
      }
      const audioBufferIds = buffers.map((buffer) =>
        resolvePipelineAudioBufferId(buffer)
      );
      const result = await SherpaOnnx.enrollSpeakerOffline(
        engine.instanceId,
        manager.managerId,
        trimmed,
        audioBufferIds,
        null,
        null
      );
      if (!result.ok) {
        throw new Error(
          `Failed to enroll speaker '${trimmed}' (name may already exist)`
        );
      }
    },
    async enrollOfflineSegments(
      nameOrNames: string | string[],
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource,
      segmentOptions?: SpeakerIdentificationSegmentOptions
    ): Promise<void> {
      guard();
      assertSegmentOptions(segmentOptions);
      const audioBufferId = resolvePipelineAudioBufferId(audioIn);
      resolveOfflineSegmentBufferId(segmentsIn);
      const spans = collectSpeechSpans(
        await getOfflineSegmentBufferSegments(segmentsIn)
      );
      if (spans.length === 0) {
        throw new Error(
          'enrollOfflineSegments() requires at least one non-empty speech span'
        );
      }

      const trimmedPerSpan = resolvePerSpanSpeakerNames(
        nameOrNames,
        spans.length,
        'enrollOfflineSegments'
      );

      const uniqueNames = [...new Set(trimmedPerSpan)];
      for (const uniqueName of uniqueNames) {
        if (await manager.contains(uniqueName)) {
          throw new Error(
            `Speaker '${uniqueName}' is already enrolled. Remove them first or choose another name.`
          );
        }
      }

      const progressSession = createSpeakerIdentificationProgressSession(
        segmentOptions?.onProgress
      );
      const byName = new Map<
        string,
        { startSamples: number[]; endSamples: number[] }
      >();
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i]!;
        const speakerName = trimmedPerSpan[i]!;
        progressSession.emitStep(i, spans.length, spanDurationMs(span));
        const bucket = byName.get(speakerName);
        if (bucket) {
          bucket.startSamples.push(span.startSample);
          bucket.endSamples.push(span.endSample);
        } else {
          byName.set(speakerName, {
            startSamples: [span.startSample],
            endSamples: [span.endSample],
          });
        }
      }

      for (const [speakerName, ranges] of byName) {
        const audioBufferIds = ranges.startSamples.map(() => audioBufferId);
        const result = await SherpaOnnx.enrollSpeakerOffline(
          engine.instanceId,
          manager.managerId,
          speakerName,
          audioBufferIds,
          ranges.startSamples,
          ranges.endSamples
        );
        if (!result.ok) {
          throw new Error(
            `Failed to enroll speaker '${speakerName}' (name may already exist)`
          );
        }
      }
    },
    async identify(
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<IdentifyResult> {
      guard();
      const result = await SherpaOnnx.identifySpeakerOffline(
        engine.instanceId,
        manager.managerId,
        resolvePipelineAudioBufferId(audio),
        resolveThreshold(thresholdOptions),
        null,
        null
      );
      const trimmed = result.name.trim();
      return { name: trimmed.length > 0 ? trimmed : null };
    },
    async search(
      embedding: Float32Array,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<string | null> {
      guard();
      if (!(embedding instanceof Float32Array) || embedding.length === 0) {
        throw new Error('search() requires a non-empty Float32Array embedding');
      }
      if (embedding.length !== manager.dim) {
        throw new Error(
          `search() embedding length ${embedding.length} does not match manager dim ${manager.dim}`
        );
      }
      const name = await manager.search(
        embedding,
        resolveThreshold(thresholdOptions)
      );
      const trimmed = typeof name === 'string' ? name.trim() : '';
      return trimmed.length > 0 ? trimmed : null;
    },
    async labelOfflineSegments(
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource,
      segmentsOut: OfflineSegmentBufferIdSource,
      segmentOptions?: SpeakerIdentificationLabelOptions
    ): Promise<LabelOfflineSegmentsResult> {
      guard();
      assertLabelOptions(segmentOptions);
      const audioBufferId = resolvePipelineAudioBufferId(audioIn);
      const segmentsInId = resolveOfflineSegmentBufferId(segmentsIn);
      const segmentsOutId = resolveOfflineSegmentBufferId(segmentsOut);
      const threshold = resolveThreshold(segmentOptions);

      const hasCallbacks =
        typeof segmentOptions?.onProgress === 'function' ||
        typeof segmentOptions?.onLabeled === 'function';

      if (!hasCallbacks) {
        return await SherpaOnnx.labelSpeakerIdentificationOfflineSegments(
          engine.instanceId,
          manager.managerId,
          audioBufferId,
          segmentsInId,
          segmentsOutId,
          threshold
        );
      }

      const spans = collectSpeechSpans(
        await getOfflineSegmentBufferSegments(segmentsIn)
      );

      if (spans.length === 0) {
        return { labeledCount: 0, unknownCount: 0 };
      }

      const progressSession = createSpeakerIdentificationProgressSession(
        segmentOptions?.onProgress
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

        for (let i = 0; i < spans.length; i++) {
          const span = spans[i]!;
          const durationMs = spanDurationMs(span);
          progressSession.emitStep(i, spans.length, durationMs);

          const result = await SherpaOnnx.identifySpeakerOffline(
            engine.instanceId,
            manager.managerId,
            audioBufferId,
            threshold,
            span.startSample,
            span.endSample
          );
          const trimmed = result.name.trim();
          const speakerName = trimmed.length > 0 ? trimmed : null;
          if (speakerName == null) {
            unknownCount += 1;
          } else {
            labeledCount += 1;
          }

          const sampleRate = span.sampleRate;

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

          segmentOptions?.onLabeled?.({
            segmentIndex: i,
            totalSegments: spans.length,
            startSample: span.startSample,
            endSample: span.endSample,
            sampleRate,
            durationMs,
            speakerName,
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
    async labelLiveSegments(
      audioIn: LiveAudioBufferIdSource,
      segmentsOut: LiveSegmentBufferIdSource,
      liveOptions: SpeakerIdentificationLiveLabelOptions
    ) {
      guard();
      return labelLiveSegments(
        engine,
        manager,
        audioIn,
        segmentsOut,
        liveOptions
      );
    },
    async verify(
      name: string,
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<boolean> {
      guard();
      const result = await SherpaOnnx.verifySpeakerOffline(
        engine.instanceId,
        manager.managerId,
        resolvePipelineAudioBufferId(audio),
        name,
        resolveThreshold(thresholdOptions),
        null,
        null
      );
      return result.ok;
    },
    async verifyOfflineSegments(
      nameOrNames: string | string[],
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource,
      verifyOptions?: SpeakerIdentificationVerifyOptions
    ): Promise<VerifyOfflineSegmentsResult> {
      guard();
      assertVerifyOptions(verifyOptions);
      const audioBufferId = resolvePipelineAudioBufferId(audioIn);
      resolveOfflineSegmentBufferId(segmentsIn);
      const threshold = resolveThreshold(verifyOptions);
      const spans = collectSpeechSpans(
        await getOfflineSegmentBufferSegments(segmentsIn)
      );
      if (spans.length === 0) {
        throw new Error(
          'verifyOfflineSegments() requires at least one non-empty speech span'
        );
      }

      const expectedPerSpan = resolvePerSpanSpeakerNames(
        nameOrNames,
        spans.length,
        'verifyOfflineSegments'
      );

      const progressSession = createSpeakerIdentificationProgressSession(
        verifyOptions?.onProgress
      );
      const matches: boolean[] = [];
      let matchCount = 0;
      let mismatchCount = 0;

      for (let i = 0; i < spans.length; i++) {
        const span = spans[i]!;
        const expectedName = expectedPerSpan[i]!;
        const durationMs = spanDurationMs(span);
        progressSession.emitStep(i, spans.length, durationMs);
        const result = await SherpaOnnx.verifySpeakerOffline(
          engine.instanceId,
          manager.managerId,
          audioBufferId,
          expectedName,
          threshold,
          span.startSample,
          span.endSample
        );
        const matched = result.ok;
        matches.push(matched);
        if (matched) {
          matchCount += 1;
        } else {
          mismatchCount += 1;
        }
        verifyOptions?.onVerified?.({
          segmentIndex: i,
          totalSegments: spans.length,
          startSample: span.startSample,
          endSample: span.endSample,
          sampleRate: span.sampleRate,
          durationMs,
          expectedName,
          matched,
        });
      }

      return { matchCount, mismatchCount, matches };
    },
    async removeSpeaker(name: string): Promise<boolean> {
      guard();
      return manager.remove(name.trim());
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
    async exportEnrollments(): Promise<SpeakerEnrollmentBundle> {
      guard();
      const names = await manager.listSpeakers();
      const speakers: SpeakerEnrollmentBundle['speakers'] = [];
      for (const name of names) {
        const embedding = await manager.getEmbedding(name);
        if (embedding == null || embedding.length !== manager.dim) {
          throw new Error(
            `SID_ENROLL_INVALID_RESULT: missing embedding for speaker '${name}'`
          );
        }
        speakers.push({
          name,
          embeddings: [Array.from(embedding)],
        });
      }
      return {
        version: ENROLLMENT_BUNDLE_VERSION,
        dim: manager.dim,
        modelKey,
        speakers,
      };
    },
    async importEnrollments(
      bundle: SpeakerEnrollmentBundle,
      importOptions?: ImportEnrollmentsOptions
    ): Promise<ImportEnrollmentsResult> {
      guard();
      assertEnrollmentBundle(bundle, manager.dim, modelKey);
      const replaceExisting = importOptions?.replaceExisting === true;

      let imported = 0;
      const skipped = 0;

      for (let i = 0; i < bundle.speakers.length; i++) {
        const entry = bundle.speakers[i];
        if (entry == null || typeof entry !== 'object') {
          throw new Error(
            `SID_ENROLLMENT_BUNDLE_INVALID: speakers[${i}] must be an object`
          );
        }
        const trimmed = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (trimmed.length === 0) {
          throw new Error(
            `SID_ENROLLMENT_BUNDLE_INVALID: speakers[${i}].name must be a non-empty string`
          );
        }
        if (!Array.isArray(entry.embeddings) || entry.embeddings.length === 0) {
          throw new Error(
            `SID_ENROLLMENT_BUNDLE_INVALID: speakers[${i}].embeddings must be a non-empty array`
          );
        }
        const embeddings = numberArraysToEmbeddings(
          entry.embeddings,
          manager.dim
        );

        if (replaceExisting) {
          await manager.remove(trimmed);
        }

        const ok = await manager.add(trimmed, embeddings);
        if (!ok) {
          throw new Error(
            `Failed to import speaker '${trimmed}' (name may already exist)`
          );
        }
        imported += 1;
      }

      return { imported, skipped };
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await manager.destroy();
      await engine.destroy();
    },
  };
}
