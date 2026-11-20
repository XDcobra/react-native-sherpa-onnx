/**
 * Copy time ranges of an offline audio buffer into a new offline buffer.
 *
 * Built from the public buffer primitives: the ranges are read in bounded chunks
 * and appended to a spooled live accumulator, which is then transferred (no copy)
 * into the result buffer.
 */

import { unlink } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import { throwIfOrchestrationAborted } from '../pipeline/cancellation';
import {
  appendSamplesToLiveAudioBuffer,
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromOffline,
  finalizeLiveAudioBuffer,
  getOfflineAudioBufferSamplesSlice,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  transferOfflineAudioBufferFromLive,
} from './index';
import { PipelineAudioErrorCode } from './types';
import type {
  AudioRangeMapping,
  AudioTimeRange,
  OfflineAudioBufferFromRangesRef,
  OfflineAudioBufferIdSource,
  OfflineAudioBufferRef,
  OfflineFromRangesOptions,
  PipelineAudioBufferIdSource,
} from './types';

/** Longest piece read from the source at once, in seconds of audio. */
const COPY_CHUNK_SECONDS = 5;

let spoolCounter = 0;

/** A source range in frames: `[start, end)`. */
type FrameRange = { start: number; end: number };

function invalidArgument(message: string): Error {
  return new Error(`${PipelineAudioErrorCode.INVALID_ARGUMENT}: ${message}`);
}

function msToFrames(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

function framesToMs(frames: number, sampleRate: number): number {
  return (frames * 1000) / sampleRate;
}

/**
 * Turns `ranges` into sorted, non-overlapping frame ranges inside `[0, numFrames)`.
 * Ranges are clamped to the buffer, empty ones dropped, overlapping or touching
 * ones merged.
 */
function normalizeRanges(
  ranges: ReadonlyArray<AudioTimeRange>,
  sampleRate: number,
  numFrames: number
): FrameRange[] {
  const clamped: FrameRange[] = [];
  for (const range of ranges) {
    const startMs = range?.startMs;
    const endMs = range?.endMs;
    if (
      typeof startMs !== 'number' ||
      typeof endMs !== 'number' ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs)
    ) {
      throw invalidArgument('every range needs finite startMs and endMs');
    }
    const start = Math.min(
      numFrames,
      Math.max(0, msToFrames(startMs, sampleRate))
    );
    const end = Math.min(numFrames, Math.max(0, msToFrames(endMs, sampleRate)));
    if (end > start) {
      clamped.push({ start, end });
    }
  }
  clamped.sort((a, b) => a.start - b.start);

  const merged: FrameRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

async function resolveRangesSpoolPath(): Promise<string> {
  const tmpDir = await SherpaOnnx.resolveAppBaseDir('tmp');
  const base = tmpDir.endsWith('/') ? tmpDir.slice(0, -1) : tmpDir;
  const id = `${Date.now()}_${++spoolCounter}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  // Same `orch_` prefix as the orchestrator's spools, for the native orphan sweep.
  return `${base}/orch_ranges_${id}.wav`;
}

async function releaseQuietly(
  bufferId: PipelineAudioBufferIdSource
): Promise<void> {
  try {
    await releasePipelineAudioBuffer(bufferId);
  } catch {
    // Best-effort cleanup on the failure path.
  }
}

/**
 * Copy time ranges of an offline audio buffer into a new offline buffer.
 *
 * Ranges are clamped to the source length, empty ones dropped, then sorted and
 * merged where they overlap or touch. The merged ranges are copied in source
 * order, with `gapMs` of silence between two of them. `mapping` has one entry
 * per merged range, so times in the result can be translated back to the source.
 *
 * The copy reads at most a few seconds at a time and writes to a spool file, so
 * memory stays bounded for long sources. Only mono buffers are supported.
 *
 * On error or abort, the accumulator it created is released and its spool file deleted.
 * @throws {Error} `AUDIO_INVALID_ARGUMENT` — malformed id, multi-channel source,
 *   invalid `gapMs` / `targetSampleRateHz`, a range without finite times, or no
 *   range left inside the source after normalisation.
 * @throws {Error} `AUDIO_BUFFER_KIND_MISMATCH` — the source is not an offline buffer.
 * @throws {Error} `AUDIO_BUFFER_NOT_FOUND` — the source was released.
 * @throws {Error} `AUDIO_SPOOL_NOT_AVAILABLE` — the accumulator got no spool file.
 * @throws {Error} `ORCHESTRATION_CANCELLED` — `options.signal` aborted (`name: 'AbortError'`).
 * @throws {Error} `JSI_NOT_INSTALLED` — JSI bindings are not available.
 */
export async function createOfflineAudioBufferFromRanges(
  source: OfflineAudioBufferIdSource,
  ranges: ReadonlyArray<AudioTimeRange>,
  options?: OfflineFromRangesOptions
): Promise<OfflineAudioBufferFromRangesRef> {
  const signal = options?.signal;
  const gapMs = options?.gapMs ?? 0;
  const targetSampleRateHz = options?.targetSampleRateHz ?? 0;
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw invalidArgument('gapMs must be a finite number >= 0');
  }
  if (!Number.isFinite(targetSampleRateHz) || targetSampleRateHz < 0) {
    throw invalidArgument('targetSampleRateHz must be 0 or > 0');
  }
  if (!Array.isArray(ranges)) {
    throw invalidArgument('ranges must be an array');
  }
  throwIfOrchestrationAborted(signal);

  const info = await getPipelineAudioBufferInfo(source);
  if (info.kind !== 'offlinePcmBuffer') {
    throw new Error(
      `${PipelineAudioErrorCode.BUFFER_KIND_MISMATCH}: createOfflineAudioBufferFromRanges requires an offline buffer`
    );
  }
  if (info.channelCount !== 1) {
    throw invalidArgument(
      `only mono sources are supported (channelCount ${info.channelCount})`
    );
  }
  const sampleRate = info.sampleRate;
  if (!(sampleRate > 0)) {
    throw invalidArgument('source has no sample rate');
  }

  const frameRanges = normalizeRanges(ranges, sampleRate, info.numSamples);
  if (frameRanges.length === 0) {
    throw invalidArgument('no range lies inside the source audio');
  }

  const gapFrames = msToFrames(gapMs, sampleRate);
  const chunkFrames = Math.max(1, Math.round(COPY_CHUNK_SECONDS * sampleRate));
  const totalFrames =
    frameRanges.reduce((sum, r) => sum + (r.end - r.start), 0) +
    gapFrames * (frameRanges.length - 1);

  throwIfOrchestrationAborted(signal);
  const spoolPath = await resolveRangesSpoolPath();
  const accumulator = await createEmptyLiveAudioBuffer({
    sampleRate,
    channelCount: 1,
    retention: { mode: 'path', path: spoolPath, trim: 'session' },
    segmentation: { mode: 'off' },
  });
  const liveId = accumulator.bufferId;

  const mapping: AudioRangeMapping[] = [];
  let built: OfflineAudioBufferRef;
  try {
    if (!accumulator.info.hasActiveSpool) {
      throw new Error(
        `${PipelineAudioErrorCode.SPOOL_NOT_AVAILABLE}: the accumulator has no spool file`
      );
    }

    let outFrames = 0;
    const silence = gapFrames > 0 ? new Float32Array(gapFrames) : null;
    for (const [i, range] of frameRanges.entries()) {
      if (i > 0 && silence) {
        throwIfOrchestrationAborted(signal);
        appendSamplesToLiveAudioBuffer(liveId, silence, sampleRate);
        outFrames += gapFrames;
      }
      const outStart = outFrames;
      let pos = range.start;
      while (pos < range.end) {
        throwIfOrchestrationAborted(signal);
        const count = Math.min(chunkFrames, range.end - pos);
        const samples = getOfflineAudioBufferSamplesSlice(source, pos, count);
        if (samples.length === 0) {
          break;
        }
        appendSamplesToLiveAudioBuffer(liveId, samples, sampleRate);
        pos += samples.length;
        outFrames += samples.length;
        options?.onProgress?.(Math.min(1, outFrames / totalFrames));
      }
      mapping.push({
        sourceStartMs: framesToMs(range.start, sampleRate),
        sourceEndMs: framesToMs(pos, sampleRate),
        outputStartMs: framesToMs(outStart, sampleRate),
        outputEndMs: framesToMs(outFrames, sampleRate),
      });
    }
    if (outFrames === 0) {
      throw invalidArgument('no range lies inside the source audio');
    }

    throwIfOrchestrationAborted(signal);
    await finalizeLiveAudioBuffer(liveId);
    built = await transferOfflineAudioBufferFromLive(liveId, 'fullIfSpooled');
  } catch (err) {
    await releaseQuietly(liveId);
    // Release keeps a spool file at a caller-chosen path, so remove it here.
    await unlink(spoolPath).catch(() => {});
    throw err;
  }

  if (targetSampleRateHz > 0 && targetSampleRateHz !== sampleRate) {
    const intermediate = built;
    try {
      throwIfOrchestrationAborted(signal);
      built = await createOfflineAudioBufferFromOffline(intermediate, {
        targetSampleRateHz,
      });
    } finally {
      await releaseQuietly(intermediate.bufferId);
    }
  }

  options?.onProgress?.(1);
  return { ...built, mapping };
}
