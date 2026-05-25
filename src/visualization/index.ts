import SherpaOnnx from '../NativeSherpaOnnx';
import {
  resolvePipelineAudioBufferId,
  type PipelineAudioBufferIdSource,
} from '../audiobuffer';
import type { FileSource } from '../fileio/types';
import type {
  AudioVisualizationInput,
  AudioVisualizationKind,
  AudioVisualizationOptions,
  AudioVisualizationProfile,
  AudioVisualizationTimeAggregate,
} from './types';
import { takeVisualizationFrames } from './jsi';

const FILE_SOURCE_KINDS = new Set([
  'fs',
  'app',
  'contentUri',
  'securityScoped',
  'pad',
]);

const DEFAULT_KIND: AudioVisualizationKind = 'spectrum_bars';
const DEFAULT_BAR_COUNT = 96;
const DEFAULT_MIN_HZ = 60;
const DEFAULT_TIME_AGGREGATE: AudioVisualizationTimeAggregate = 'max_hold';
const MIN_BAR_COUNT = 8;
const MAX_BAR_COUNT = 512;
const MIN_MIN_HZ = 10;
const MIN_FRAME_COUNT = 8;
const MAX_FRAME_COUNT = 512;
const MIN_FRAME_DURATION_MS = 50;
const MAX_FRAME_DURATION_MS = 10_000;
const DEFAULT_FRAME_DURATION_MS = 500;
const MAX_FRAME_PAYLOAD_FLOATS = 131_072;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isFileSource(value: unknown): value is FileSource {
  if (!isPlainObject(value)) {
    return false;
  }
  const kind = value.kind;
  return typeof kind === 'string' && FILE_SOURCE_KINDS.has(kind);
}

function assertLiveHandle(value: string): string {
  const id = value.trim();
  if (!id.startsWith('live_')) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_INPUT: live handle must start with live_'
    );
  }
  return id;
}

function normalizeInput(input: AudioVisualizationInput): {
  kind: 'file' | 'offline' | 'live';
  source?: FileSource;
  bufferId?: string;
  handle?: string;
} {
  if (isPlainObject(input) && typeof input.kind === 'string') {
    if (input.kind === 'file') {
      const source = input.source;
      if (!isFileSource(source)) {
        throw new Error(
          'AUDIO_VISUALIZATION_INVALID_INPUT: file input requires a valid FileSource'
        );
      }
      return {
        kind: 'file',
        source,
      };
    }

    if (input.kind === 'offline') {
      const source = input.buffer as PipelineAudioBufferIdSource;
      const bufferId = resolvePipelineAudioBufferId(source);
      if (!bufferId.startsWith('off_')) {
        throw new Error(
          'AUDIO_VISUALIZATION_INVALID_INPUT: offline input requires an off_ buffer id'
        );
      }
      return {
        kind: 'offline',
        bufferId,
      };
    }

    if (input.kind === 'live') {
      return {
        kind: 'live',
        handle: assertLiveHandle(String(input.handle ?? '')),
      };
    }

    if (isFileSource(input)) {
      return {
        kind: 'file',
        source: input,
      };
    }
  }

  if (isFileSource(input)) {
    return {
      kind: 'file',
      source: input,
    };
  }

  const id = resolvePipelineAudioBufferId(input as PipelineAudioBufferIdSource);
  if (id.startsWith('off_')) {
    return {
      kind: 'offline',
      bufferId: id,
    };
  }
  if (id.startsWith('live_')) {
    return {
      kind: 'live',
      handle: id,
    };
  }

  throw new Error(
    'AUDIO_VISUALIZATION_INVALID_INPUT: expected FileSource, off_ buffer, or live_ handle'
  );
}

function normalizePositiveNumber(
  value: number | undefined,
  fallback: number,
  min: number
): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_OPTIONS: expected finite number'
    );
  }
  return Math.max(min, value);
}

function normalizeFiniteNonNegative(
  value: number | undefined,
  fallback: number
): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_OPTIONS: expected finite number'
    );
  }
  return Math.max(0, value);
}

function toUnitFloat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function normalizeOptions(options: AudioVisualizationOptions | undefined): {
  kind: AudioVisualizationKind;
  barCount: number;
  minHz: number;
  maxHz: number;
  timeAggregate: AudioVisualizationTimeAggregate;
  includeTimeline: boolean;
  frameCount: number;
  frameDurationMs: number;
  maxAnalysisDurationMs: number;
} {
  const kind = options?.kind ?? DEFAULT_KIND;
  if (kind !== DEFAULT_KIND) {
    throw new Error(
      `AUDIO_VISUALIZATION_INVALID_OPTIONS: unsupported kind ${kind}`
    );
  }

  const requestedBarCount = Math.trunc(options?.barCount ?? DEFAULT_BAR_COUNT);
  const barCount = Math.max(
    MIN_BAR_COUNT,
    Math.min(MAX_BAR_COUNT, requestedBarCount)
  );

  const minHz = normalizePositiveNumber(
    options?.minHz,
    DEFAULT_MIN_HZ,
    MIN_MIN_HZ
  );
  const maxHzRaw = options?.maxHz;
  const maxHz =
    maxHzRaw == null
      ? 0
      : Math.max(
          minHz + 1,
          normalizePositiveNumber(maxHzRaw, 0, MIN_MIN_HZ + 1)
        );

  const timeAggregate = options?.timeAggregate ?? DEFAULT_TIME_AGGREGATE;
  if (timeAggregate !== 'max_hold' && timeAggregate !== 'mean') {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_OPTIONS: timeAggregate must be max_hold or mean'
    );
  }

  const hasFrameCount = options?.frameCount != null;
  const hasFrameDuration = options?.frameDurationMs != null;
  const includeTimeline =
    options?.includeTimeline === true || hasFrameCount || hasFrameDuration;

  let frameCount = 0;
  let frameDurationMs = 0;

  if (includeTimeline) {
    if (hasFrameCount) {
      frameCount = Math.trunc(
        normalizeFiniteNonNegative(options?.frameCount, 0)
      );
      if (frameCount < MIN_FRAME_COUNT || frameCount > MAX_FRAME_COUNT) {
        throw new Error(
          'AUDIO_VISUALIZATION_INVALID_OPTIONS: frameCount must be between 8 and 512'
        );
      }
      if (frameCount * barCount > MAX_FRAME_PAYLOAD_FLOATS) {
        throw new Error(
          'AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE: frameCount * barCount exceeds 131072'
        );
      }
    } else {
      frameDurationMs = normalizePositiveNumber(
        options?.frameDurationMs,
        DEFAULT_FRAME_DURATION_MS,
        1
      );
      if (
        frameDurationMs < MIN_FRAME_DURATION_MS ||
        frameDurationMs > MAX_FRAME_DURATION_MS
      ) {
        throw new Error(
          'AUDIO_VISUALIZATION_INVALID_OPTIONS: frameDurationMs must be between 50 and 10000'
        );
      }
    }
  }

  const maxAnalysisDurationMs = normalizeFiniteNonNegative(
    options?.maxAnalysisDurationMs,
    0
  );

  return {
    kind,
    barCount,
    minHz,
    maxHz,
    timeAggregate,
    includeTimeline,
    frameCount,
    frameDurationMs,
    maxAnalysisDurationMs,
  };
}

export async function computeAudioVisualizationProfile(
  input: AudioVisualizationInput,
  options?: AudioVisualizationOptions
): Promise<AudioVisualizationProfile> {
  const normalizedInput = normalizeInput(input);
  const normalizedOptions = normalizeOptions(options);

  const nativeResult = await SherpaOnnx.computeAudioVisualizationProfile(
    normalizedInput as Object,
    normalizedOptions as Object
  );

  const barCount =
    typeof nativeResult?.barCount === 'number' &&
    Number.isFinite(nativeResult.barCount)
      ? Math.max(1, Math.trunc(nativeResult.barCount))
      : normalizedOptions.barCount;

  const sourceLevels = Array.isArray(nativeResult?.levels)
    ? nativeResult.levels
    : [];

  const levels = Array.from({ length: barCount }, (_, i) =>
    toUnitFloat(sourceLevels[i])
  );

  const sampleRate =
    typeof nativeResult?.sampleRate === 'number' &&
    Number.isFinite(nativeResult.sampleRate)
      ? Math.max(0, Math.trunc(nativeResult.sampleRate))
      : 0;

  const durationMs =
    typeof nativeResult?.durationMs === 'number' &&
    Number.isFinite(nativeResult.durationMs)
      ? Math.max(0, nativeResult.durationMs)
      : 0;

  const nativeFrameCount =
    typeof nativeResult?.frameCount === 'number' &&
    Number.isFinite(nativeResult.frameCount)
      ? Math.max(0, Math.trunc(nativeResult.frameCount))
      : 0;

  const frameCount = nativeFrameCount;

  const frameDurationMs =
    frameCount > 0 &&
    typeof nativeResult?.frameDurationMs === 'number' &&
    Number.isFinite(nativeResult.frameDurationMs)
      ? Math.max(0, nativeResult.frameDurationMs)
      : 0;

  const expectedFramesLength = frameCount * barCount;
  let frames: Float32Array | undefined;

  const framesTransferId =
    typeof nativeResult?.framesTransferId === 'string'
      ? nativeResult.framesTransferId.trim()
      : '';

  if (frameCount > 0 && framesTransferId.length > 0) {
    const buffer = takeVisualizationFrames(framesTransferId);
    let data = new Float32Array(buffer);
    if (data.length !== expectedFramesLength) {
      if (data.length > expectedFramesLength) {
        data = data.slice(0, expectedFramesLength);
      } else {
        const padded = new Float32Array(expectedFramesLength);
        padded.set(data);
        data = padded;
      }
    }

    for (let i = 0; i < data.length; i += 1) {
      data[i] = toUnitFloat(data[i]);
    }
    frames = data;
  }

  return {
    kind: DEFAULT_KIND,
    sampleRate,
    durationMs,
    barCount,
    levels,
    frameCount,
    frameDurationMs,
    frames,
  };
}

export type {
  AudioVisualizationInput,
  AudioVisualizationKind,
  AudioVisualizationOptions,
  AudioVisualizationProfile,
  AudioVisualizationTimeAggregate,
} from './types';
