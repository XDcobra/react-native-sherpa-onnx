import {
  appendOfflineToLiveAudioBuffer,
  appendSamplesToLiveAudioBuffer,
  createEmptyLiveAudioBuffer,
  createEmptyOfflineAudioBuffer,
  createOfflineAudioBufferFromSamples,
  finalizeLiveAudioBuffer,
  getOfflineAudioBufferSamplesSlice,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  transferOfflineAudioBufferFromLive,
} from '../audiobuffer';
import type {
  LiveAudioBufferRef,
  OfflineAudioBufferInfo,
  OfflineAudioBufferRef,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import { getSegments } from '../segment';
import type { Segment, SpeechSegment, TextSegment } from '../segment/segment';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from '../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferInfo,
  OfflineTextBufferRef,
} from '../textbuffer/types';
import type { SegmentLinkMapRef } from '../segment/segment-link';
import SherpaOnnx from '../NativeSherpaOnnx';

export type ErrorRecoveryStrategy =
  | 'abort'
  | 'skip'
  | 'retry'
  | 'partial_result';

export type RetryExhaustedFallback = 'abort' | 'skip';

export interface OrchestrationProgress {
  currentSegment: number;
  totalSegments: number;
  fraction: number;
  currentSegmentDurationMs: number;
  elapsedMs: number;
}

export interface SkippedSegmentInfo {
  segmentIndex: number;
  segmentId: string;
  error: string;
  retryCount: number;
}

export interface FailedSegmentInfo {
  segmentIndex: number;
  segmentId: string;
  error: string;
  retryCount: number;
}

export interface OrchestrationConfig {
  segmentation?: {
    mode?: 'off' | 'manual' | 'auto';
  };
  errorRecovery?: ErrorRecoveryStrategy;
  maxRetriesPerSegment?: number;
  retryExhaustedFallback?: RetryExhaustedFallback;
  abortSignal?: AbortSignal;
  onProgress?: (progress: OrchestrationProgress) => void;
  overlapSamples?: number;
  overlapChars?: number;
  textSkipPlaceholder?: string;
  linkMap?: SegmentLinkMapRef;
}

export interface OrchestrationResult<TOutput> {
  outputBuffer?: TOutput;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  totalSegments: number;
  completedSegments: number;
  skippedSegments: SkippedSegmentInfo[];
  failedSegment?: FailedSegmentInfo;
  processingTimeMs: number;
  linkMap?: SegmentLinkMapRef;
}

type SessionState =
  | 'created'
  | 'running'
  | 'recovering'
  | 'completing'
  | 'done'
  | 'failed'
  | 'cancelled';

let sessionCounter = 0;

function nextSessionId(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}_${Date.now()}_${sessionCounter}`;
}

class OrchestrationSession {
  private _state: SessionState = 'created';
  private readonly _startedAtMs = Date.now();
  private _completedSegments = 0;
  private readonly _skippedSegments: SkippedSegmentInfo[] = [];
  private _failedSegment: FailedSegmentInfo | undefined;

  constructor(readonly sessionId: string) {}

  get state(): SessionState {
    return this._state;
  }

  get startedAtMs(): number {
    return this._startedAtMs;
  }

  get completedSegments(): number {
    return this._completedSegments;
  }

  get skippedSegments(): SkippedSegmentInfo[] {
    return this._skippedSegments;
  }

  get failedSegment(): FailedSegmentInfo | undefined {
    return this._failedSegment;
  }

  start(): void {
    this.assertState('created');
    this._state = 'running';
  }

  markRecovering(): void {
    if (this._state === 'running' || this._state === 'recovering') {
      this._state = 'recovering';
    }
  }

  markCompleting(): void {
    if (
      this._state === 'running' ||
      this._state === 'recovering' ||
      this._state === 'cancelled'
    ) {
      this._state = 'completing';
    }
  }

  markDone(): void {
    this._state = 'done';
  }

  cancel(): void {
    if (this.isTerminal()) return;
    this._state = 'cancelled';
  }

  fail(failed: FailedSegmentInfo): void {
    this._failedSegment = failed;
    this._state = 'failed';
  }

  addCompletedSegment(): void {
    this._completedSegments += 1;
  }

  addSkippedSegment(skipped: SkippedSegmentInfo): void {
    this._skippedSegments.push(skipped);
  }

  setFailedSegment(failed: FailedSegmentInfo): void {
    this._failedSegment = failed;
  }

  isTerminal(): boolean {
    return (
      this._state === 'done' ||
      this._state === 'failed' ||
      this._state === 'cancelled'
    );
  }

  private assertState(expected: SessionState): void {
    if (this._state !== expected) {
      throw new Error(
        `ORCHESTRATION_INVALID_STATE: expected ${expected}, got ${this._state}`
      );
    }
  }
}

function normalizeRecovery(
  strategy: ErrorRecoveryStrategy | undefined
): ErrorRecoveryStrategy {
  return strategy ?? 'abort';
}

function normalizeRetryCount(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 2;
  return Math.max(0, Math.trunc(value));
}

function normalizeRetryFallback(
  value: RetryExhaustedFallback | undefined
): RetryExhaustedFallback {
  return value === 'skip' ? 'skip' : 'abort';
}

function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function shouldReturnPartialOnCancel(strategy: ErrorRecoveryStrategy): boolean {
  return strategy === 'skip' || strategy === 'partial_result';
}

function formatError(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

function reportProgress(
  session: OrchestrationSession,
  config: OrchestrationConfig,
  currentSegment: number,
  totalSegments: number,
  currentSegmentDurationMs: number
): void {
  if (!config.onProgress) return;
  const fraction = totalSegments > 0 ? currentSegment / totalSegments : 1;
  config.onProgress({
    currentSegment,
    totalSegments,
    fraction,
    currentSegmentDurationMs,
    elapsedMs: Date.now() - session.startedAtMs,
  });
}

function joinPath(base: string, name: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/${name}`;
}

async function resolveOrchestrationAccumulatorPath(
  sessionId: string
): Promise<string> {
  const tmpDir = await SherpaOnnx.resolveAppBaseDir('tmp');
  return joinPath(tmpDir, `orch_${sessionId}_acc.wav`);
}

function asSpeechSegment(seg: Segment): SpeechSegment {
  if (seg.domain !== 'speech') {
    throw new Error(
      `ORCHESTRATION_INVALID_SEGMENT: expected speech segment, received ${seg.domain}`
    );
  }
  return seg;
}

function asTextSegment(seg: Segment): TextSegment {
  if (seg.domain !== 'text') {
    throw new Error(
      `ORCHESTRATION_INVALID_SEGMENT: expected text segment, received ${seg.domain}`
    );
  }
  return seg;
}

async function finalizeAudioAccumulator(
  accumulator: LiveAudioBufferRef,
  sampleRate: number,
  totalSamplesAppended: number
): Promise<OfflineAudioBufferRef> {
  const liveId = accumulator.bufferId;
  await finalizeLiveAudioBuffer(liveId);

  if (totalSamplesAppended <= 0) {
    await releasePipelineAudioBuffer(liveId);
    return createEmptyOfflineAudioBuffer(sampleRate, 1);
  }

  try {
    return await transferOfflineAudioBufferFromLive(liveId, 'fullIfSpooled');
  } catch {
    // Transfer failed after finalize: ensure live accumulator is released.
    await releasePipelineAudioBuffer(liveId);
    throw new Error(
      'ORCHESTRATION_TRANSFER_FAILED: failed to transfer finalized accumulator to offline buffer'
    );
  }
}

async function collectSpeechSegments(
  input: OfflineAudioBufferIdSource,
  info: OfflineAudioBufferInfo,
  config: OrchestrationConfig,
  sessionId: string
): Promise<SpeechSegment[]> {
  const mode = config.segmentation?.mode ?? 'off';
  if (mode === 'off') {
    if (info.numSamples <= 0) return [];
    return [
      {
        segmentId: `speech_full_${sessionId}`,
        domain: 'speech',
        startOffset: 0,
        endOffset: info.numSamples,
        reason: 'finalize',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        sourceAudioBufferId: info.bufferId,
        sampleRate: info.sampleRate,
        durationMs:
          info.sampleRate > 0 ? (info.numSamples / info.sampleRate) * 1000 : 0,
      },
    ];
  }

  const segments = await getSegments(input);
  return segments.map(asSpeechSegment);
}

async function collectTextSegments(
  input: OfflineTextBufferIdSource,
  info: OfflineTextBufferInfo,
  config: OrchestrationConfig,
  sessionId: string
): Promise<TextSegment[]> {
  const mode = config.segmentation?.mode ?? 'off';
  if (mode === 'off') {
    if (info.utf16Length <= 0) return [];
    const text = await getOfflineTextBufferTextSlice(
      input,
      0,
      info.utf16Length
    );
    return [
      {
        segmentId: `text_full_${sessionId}`,
        domain: 'text',
        startOffset: 0,
        endOffset: info.utf16Length,
        reason: 'finalize',
        source: 'external',
        createdAtMs: Date.now(),
        segmentIndex: 0,
        text,
        utf16Length: info.utf16Length,
      },
    ];
  }

  const segments = await getSegments(input);
  return segments.map(asTextSegment);
}

async function cleanupAudioTemporaries(
  tempIn?: OfflineAudioBufferRef,
  tempOut?: OfflineAudioBufferRef
): Promise<void> {
  if (tempIn) {
    await releasePipelineAudioBuffer(tempIn.bufferId);
  }
  if (tempOut) {
    await releasePipelineAudioBuffer(tempOut.bufferId);
  }
}

async function cleanupTextTemporaries(
  tempIn?: OfflineTextBufferRef,
  tempOut?: OfflineTextBufferRef
): Promise<void> {
  if (tempIn) {
    await releasePipelineTextBuffer(tempIn.bufferId);
  }
  if (tempOut) {
    await releasePipelineTextBuffer(tempOut.bufferId);
  }
}

export async function runOfflineAudioPipeline(
  input: OfflineAudioBufferIdSource,
  consumer: (
    segIn: OfflineAudioBufferRef,
    segOut: OfflineAudioBufferRef
  ) => Promise<void>,
  config: OrchestrationConfig = {}
): Promise<OrchestrationResult<OfflineAudioBufferRef>> {
  const strategy = normalizeRecovery(config.errorRecovery);
  const maxRetries = normalizeRetryCount(config.maxRetriesPerSegment);
  const retryFallback = normalizeRetryFallback(config.retryExhaustedFallback);
  const overlapSamples = Math.max(0, Math.trunc(config.overlapSamples ?? 0));

  const session = new OrchestrationSession(nextSessionId('audio'));

  let accumulator: LiveAudioBufferRef | undefined;
  let totalSamplesAppended = 0;

  try {
    const inputInfo = await getPipelineAudioBufferInfo(input);
    if (inputInfo.kind !== 'offlinePcmBuffer') {
      return {
        status: 'failed',
        totalSegments: 0,
        completedSegments: 0,
        skippedSegments: [],
        failedSegment: {
          segmentIndex: -1,
          segmentId: 'audio_input_kind_mismatch',
          error:
            'ORCHESTRATION_INVALID_ARGUMENT: runOfflineAudioPipeline expects an offline audio buffer',
          retryCount: 0,
        },
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    const segments = await collectSpeechSegments(
      input,
      inputInfo,
      config,
      session.sessionId
    );
    const totalSegments = segments.length;
    const accumulatorSpoolPath = await resolveOrchestrationAccumulatorPath(
      session.sessionId
    );

    accumulator = await createEmptyLiveAudioBuffer({
      sampleRate: inputInfo.sampleRate,
      channelCount: 1,
      retention: {
        mode: 'path',
        path: accumulatorSpoolPath,
        trim: 'session',
      },
      segmentation: { mode: 'off' },
    });

    session.start();

    for (const [i, seg] of segments.entries()) {
      if (isAbortRequested(config.abortSignal)) {
        session.cancel();
        break;
      }

      reportProgress(session, config, i, totalSegments, seg.durationMs ?? 0);

      let attempts = 0;
      let completed = false;
      while (!completed) {
        if (isAbortRequested(config.abortSignal)) {
          session.cancel();
          break;
        }

        let tempIn: OfflineAudioBufferRef | undefined;
        let tempOut: OfflineAudioBufferRef | undefined;
        try {
          const segLength = Math.max(0, seg.endOffset - seg.startOffset);
          const segSamples =
            segLength > 0
              ? getOfflineAudioBufferSamplesSlice(
                  input,
                  seg.startOffset,
                  segLength
                )
              : new Float32Array(0);

          tempIn = createOfflineAudioBufferFromSamples(
            segSamples,
            inputInfo.sampleRate,
            inputInfo.channelCount
          );
          tempOut = await createEmptyOfflineAudioBuffer(
            inputInfo.sampleRate,
            1
          );

          await consumer(tempIn, tempOut);
          const outInfo = await getPipelineAudioBufferInfo(tempOut.bufferId);
          if (outInfo.kind !== 'offlinePcmBuffer') {
            throw new Error(
              'ORCHESTRATION_CONSUMER_ERROR: offline audio consumer must write to an offline audio output buffer'
            );
          }

          let appendedSamples = outInfo.numSamples;
          if (outInfo.numSamples > 0) {
            if (overlapSamples > 0 && i > 0) {
              const trim = Math.min(overlapSamples, outInfo.numSamples);
              const kept = outInfo.numSamples - trim;
              appendedSamples = Math.max(0, kept);
              if (kept > 0) {
                const trimmed = getOfflineAudioBufferSamplesSlice(
                  tempOut.bufferId,
                  trim,
                  kept
                );
                appendSamplesToLiveAudioBuffer(
                  accumulator.bufferId,
                  trimmed,
                  inputInfo.sampleRate
                );
              }
            } else {
              await appendOfflineToLiveAudioBuffer(
                accumulator.bufferId,
                tempOut.bufferId
              );
            }
            totalSamplesAppended += appendedSamples;
          }

          session.addCompletedSegment();
          completed = true;
        } catch (err) {
          const error = formatError(err);
          session.markRecovering();

          if (strategy === 'retry' && attempts < maxRetries) {
            attempts += 1;
            reportProgress(
              session,
              config,
              i,
              totalSegments,
              seg.durationMs ?? 0
            );
            continue;
          }

          const exhaustedFallback =
            strategy === 'retry' ? retryFallback : strategy;

          if (exhaustedFallback === 'skip') {
            const silenceSamples = Math.max(0, seg.endOffset - seg.startOffset);
            if (silenceSamples > 0) {
              appendSamplesToLiveAudioBuffer(
                accumulator.bufferId,
                new Float32Array(silenceSamples),
                inputInfo.sampleRate
              );
              totalSamplesAppended += silenceSamples;
            }
            session.addSkippedSegment({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            completed = true;
          } else if (exhaustedFallback === 'partial_result') {
            session.setFailedSegment({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            session.markCompleting();
            completed = true;
          } else {
            session.fail({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            completed = true;
          }
        } finally {
          await cleanupAudioTemporaries(tempIn, tempOut);
        }
      }

      if (session.state === 'failed') {
        break;
      }
      if (session.state === 'cancelled') {
        break;
      }
      if (session.state === 'completing') {
        break;
      }
    }

    if (!accumulator) {
      throw new Error('ORCHESTRATION_INTERNAL_ERROR: accumulator missing');
    }

    if (session.state === 'failed') {
      await releasePipelineAudioBuffer(accumulator.bufferId);
      return {
        status: 'failed',
        totalSegments: segments.length,
        completedSegments: session.completedSegments,
        skippedSegments: session.skippedSegments,
        ...(session.failedSegment
          ? { failedSegment: session.failedSegment }
          : {}),
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    if (session.state === 'cancelled') {
      if (!shouldReturnPartialOnCancel(strategy)) {
        await releasePipelineAudioBuffer(accumulator.bufferId);
        return {
          status: 'cancelled',
          totalSegments: segments.length,
          completedSegments: session.completedSegments,
          skippedSegments: session.skippedSegments,
          processingTimeMs: Date.now() - session.startedAtMs,
          linkMap: config.linkMap,
        };
      }

      session.markCompleting();
      const outputBuffer = await finalizeAudioAccumulator(
        accumulator,
        inputInfo.sampleRate,
        totalSamplesAppended
      );
      session.markDone();
      return {
        outputBuffer,
        status: 'cancelled',
        totalSegments: segments.length,
        completedSegments: session.completedSegments,
        skippedSegments: session.skippedSegments,
        ...(session.failedSegment
          ? { failedSegment: session.failedSegment }
          : {}),
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    session.markCompleting();
    const outputBuffer = await finalizeAudioAccumulator(
      accumulator,
      inputInfo.sampleRate,
      totalSamplesAppended
    );

    const status: 'complete' | 'partial' =
      session.failedSegment != null ? 'partial' : 'complete';

    session.markDone();
    return {
      outputBuffer,
      status,
      totalSegments: segments.length,
      completedSegments: session.completedSegments,
      skippedSegments: session.skippedSegments,
      ...(session.failedSegment
        ? { failedSegment: session.failedSegment }
        : {}),
      processingTimeMs: Date.now() - session.startedAtMs,
      linkMap: config.linkMap,
    };
  } catch (err) {
    if (accumulator) {
      try {
        await releasePipelineAudioBuffer(accumulator.bufferId);
      } catch {
        // Ignore cleanup errors in terminal path.
      }
    }

    return {
      status: 'failed',
      totalSegments: 0,
      completedSegments: session.completedSegments,
      skippedSegments: session.skippedSegments,
      failedSegment: {
        segmentIndex: -1,
        segmentId: `${session.sessionId}_fatal`,
        error: formatError(err),
        retryCount: 0,
      },
      processingTimeMs: Date.now() - session.startedAtMs,
      linkMap: config.linkMap,
    };
  }
}

export async function runOfflineTextPipeline(
  input: OfflineTextBufferIdSource,
  consumer: (
    segIn: OfflineTextBufferRef,
    segOut: OfflineTextBufferRef
  ) => Promise<void>,
  config: OrchestrationConfig = {}
): Promise<OrchestrationResult<OfflineTextBufferRef>> {
  const strategy = normalizeRecovery(config.errorRecovery);
  const maxRetries = normalizeRetryCount(config.maxRetriesPerSegment);
  const retryFallback = normalizeRetryFallback(config.retryExhaustedFallback);
  const overlapChars = Math.max(0, Math.trunc(config.overlapChars ?? 0));
  const skipPlaceholder = config.textSkipPlaceholder ?? '';

  const session = new OrchestrationSession(nextSessionId('text'));

  try {
    const info = await getPipelineTextBufferInfo(input);
    if (info.kind !== 'offlineTextBuffer') {
      return {
        status: 'failed',
        totalSegments: 0,
        completedSegments: 0,
        skippedSegments: [],
        failedSegment: {
          segmentIndex: -1,
          segmentId: 'text_input_kind_mismatch',
          error:
            'ORCHESTRATION_INVALID_ARGUMENT: runOfflineTextPipeline expects an offline text buffer',
          retryCount: 0,
        },
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    const segments = await collectTextSegments(
      input,
      info,
      config,
      session.sessionId
    );
    const totalSegments = segments.length;
    const chunks: string[] = [];

    session.start();

    for (const [i, seg] of segments.entries()) {
      if (isAbortRequested(config.abortSignal)) {
        session.cancel();
        break;
      }

      const segLength = Math.max(0, seg.endOffset - seg.startOffset);
      const segDurationMs = segLength;
      reportProgress(session, config, i, totalSegments, segDurationMs);

      let attempts = 0;
      let completed = false;
      while (!completed) {
        if (isAbortRequested(config.abortSignal)) {
          session.cancel();
          break;
        }

        let tempIn: OfflineTextBufferRef | undefined;
        let tempOut: OfflineTextBufferRef | undefined;
        try {
          const overlapStart =
            overlapChars > 0 && i > 0
              ? Math.max(0, seg.startOffset - overlapChars)
              : seg.startOffset;
          const span = Math.max(0, seg.endOffset - overlapStart);
          const segText =
            span > 0
              ? await getOfflineTextBufferTextSlice(input, overlapStart, span)
              : '';

          tempIn = await createOfflineTextBufferFromText(segText);
          tempOut = await createEmptyOfflineTextBuffer();

          await consumer(tempIn, tempOut);
          const outInfo = await getPipelineTextBufferInfo(tempOut.bufferId);
          if (outInfo.kind !== 'offlineTextBuffer') {
            throw new Error(
              'ORCHESTRATION_CONSUMER_ERROR: offline text consumer must write to an offline text output buffer'
            );
          }
          const outText =
            outInfo.utf16Length > 0
              ? await getOfflineTextBufferTextSlice(
                  tempOut.bufferId,
                  0,
                  outInfo.utf16Length
                )
              : '';
          chunks.push(outText);
          session.addCompletedSegment();
          completed = true;
        } catch (err) {
          const error = formatError(err);
          session.markRecovering();

          if (strategy === 'retry' && attempts < maxRetries) {
            attempts += 1;
            reportProgress(session, config, i, totalSegments, segDurationMs);
            continue;
          }

          const exhaustedFallback =
            strategy === 'retry' ? retryFallback : strategy;

          if (exhaustedFallback === 'skip') {
            chunks.push(skipPlaceholder);
            session.addSkippedSegment({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            completed = true;
          } else if (exhaustedFallback === 'partial_result') {
            session.setFailedSegment({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            session.markCompleting();
            completed = true;
          } else {
            session.fail({
              segmentIndex: seg.segmentIndex,
              segmentId: seg.segmentId,
              error,
              retryCount: attempts,
            });
            completed = true;
          }
        } finally {
          await cleanupTextTemporaries(tempIn, tempOut);
        }
      }

      if (session.state === 'failed') {
        break;
      }
      if (session.state === 'cancelled') {
        break;
      }
      if (session.state === 'completing') {
        break;
      }
    }

    if (session.state === 'failed') {
      return {
        status: 'failed',
        totalSegments: segments.length,
        completedSegments: session.completedSegments,
        skippedSegments: session.skippedSegments,
        ...(session.failedSegment
          ? { failedSegment: session.failedSegment }
          : {}),
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    if (
      session.state === 'cancelled' &&
      !shouldReturnPartialOnCancel(strategy)
    ) {
      return {
        status: 'cancelled',
        totalSegments: segments.length,
        completedSegments: session.completedSegments,
        skippedSegments: session.skippedSegments,
        processingTimeMs: Date.now() - session.startedAtMs,
        linkMap: config.linkMap,
      };
    }

    const wasCancelled = session.state === 'cancelled';
    session.markCompleting();
    const finalText = chunks.join('');
    const outputBuffer =
      finalText.length > 0
        ? await createOfflineTextBufferFromText(finalText)
        : await createEmptyOfflineTextBuffer();
    const status: 'complete' | 'partial' | 'cancelled' = wasCancelled
      ? 'cancelled'
      : session.failedSegment != null
      ? 'partial'
      : 'complete';

    session.markDone();
    return {
      outputBuffer,
      status,
      totalSegments: segments.length,
      completedSegments: session.completedSegments,
      skippedSegments: session.skippedSegments,
      ...(session.failedSegment
        ? { failedSegment: session.failedSegment }
        : {}),
      processingTimeMs: Date.now() - session.startedAtMs,
      linkMap: config.linkMap,
    };
  } catch (err) {
    return {
      status: 'failed',
      totalSegments: 0,
      completedSegments: session.completedSegments,
      skippedSegments: session.skippedSegments,
      failedSegment: {
        segmentIndex: -1,
        segmentId: `${session.sessionId}_fatal`,
        error: formatError(err),
        retryCount: 0,
      },
      processingTimeMs: Date.now() - session.startedAtMs,
      linkMap: config.linkMap,
    };
  }
}
