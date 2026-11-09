import SherpaOnnx from '../NativeSherpaOnnx';
import {
  assertFileDestinationSupportedOnPlatform,
  assertFileSourceSupportedOnPlatform,
} from '../fileio/platformValidation';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';
import type {
  AudioVisualizationProfile,
  AudioVisualizationProfileFormat,
  LoadAudioVisualizationProfileOptions,
  LoadAudioVisualizationProfileSource,
  PersistAudioVisualizationProfile,
  SavedAudioVisualizationRef,
} from './types';
import { takeVisualizationFrames } from './jsi';

const FILE_SOURCE_KINDS = new Set([
  'fs',
  'app',
  'contentUri',
  'securityScoped',
  'pad',
]);

const DEFAULT_FORMAT: AudioVisualizationProfileFormat = 'sherpa_viz_v1';

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

function parseResolvedFileRef(result: {
  outputKind?: string;
  outputPath?: string;
}): ResolvedFileRef {
  const kind = result.outputKind;
  const path = result.outputPath;
  if (kind === 'contentUri' && typeof path === 'string' && path.length > 0) {
    return { kind: 'contentUri', uri: path };
  }
  if (typeof path === 'string' && path.length > 0) {
    return { kind: 'fs', path };
  }
  throw new Error('FILEIO_RESOLVE_ERROR: invalid ResolvedFileRef from native');
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

function normalizePersist(persist: PersistAudioVisualizationProfile): {
  destination: FileDestination;
  format: AudioVisualizationProfileFormat;
  includeFrames?: boolean;
  overwrite: boolean;
} {
  if (!isPlainObject(persist) || persist.destination == null) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_OPTIONS: persist.destination is required'
    );
  }
  assertFileDestinationSupportedOnPlatform(persist.destination);

  const format = persist.format ?? DEFAULT_FORMAT;
  if (format !== DEFAULT_FORMAT) {
    throw new Error(
      `AUDIO_VISUALIZATION_INVALID_OPTIONS: unsupported format ${format}`
    );
  }

  return {
    destination: persist.destination,
    format,
    includeFrames: persist.includeFrames,
    overwrite: persist.overwrite === true,
  };
}

function profileToNativePayload(
  profile: AudioVisualizationProfile,
  includeFrames: boolean
): Record<string, unknown> {
  if (profile.kind !== 'spectrum_bars') {
    throw new Error(
      `AUDIO_VISUALIZATION_INVALID_PROFILE: unsupported kind ${profile.kind}`
    );
  }
  if (
    !Number.isFinite(profile.barCount) ||
    profile.barCount <= 0 ||
    !Array.isArray(profile.levels) ||
    profile.levels.length < profile.barCount
  ) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_PROFILE: levels/barCount required'
    );
  }

  const payload: Record<string, unknown> = {
    kind: profile.kind,
    sampleRate: Math.max(0, Math.trunc(profile.sampleRate || 0)),
    durationMs: Math.max(0, profile.durationMs || 0),
    barCount: Math.trunc(profile.barCount),
    levels: profile.levels
      .slice(0, Math.trunc(profile.barCount))
      .map((v) => toUnitFloat(v)),
    frameCount: 0,
    frameDurationMs: 0,
  };

  const frames = profile.frames;
  const hasFrames =
    includeFrames &&
    profile.frameCount > 0 &&
    frames instanceof Float32Array &&
    frames.length >= profile.frameCount * profile.barCount;

  if (hasFrames) {
    const expected = profile.frameCount * profile.barCount;
    payload.frameCount = Math.trunc(profile.frameCount);
    payload.frameDurationMs = Math.max(0, profile.frameDurationMs || 0);
    payload.frames = Array.from(frames.subarray(0, expected), (v) =>
      toUnitFloat(v)
    );
  }

  return payload;
}

function mapNativeProfile(nativeResult: {
  kind?: string;
  sampleRate?: number;
  durationMs?: number;
  barCount?: number;
  levels?: number[];
  frameCount?: number;
  frameDurationMs?: number;
  framesTransferId?: string;
}): AudioVisualizationProfile {
  const barCount =
    typeof nativeResult?.barCount === 'number' &&
    Number.isFinite(nativeResult.barCount)
      ? Math.max(1, Math.trunc(nativeResult.barCount))
      : 1;

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

  const frameCount =
    typeof nativeResult?.frameCount === 'number' &&
    Number.isFinite(nativeResult.frameCount)
      ? Math.max(0, Math.trunc(nativeResult.frameCount))
      : 0;

  const frameDurationMs =
    frameCount > 0 &&
    typeof nativeResult?.frameDurationMs === 'number' &&
    Number.isFinite(nativeResult.frameDurationMs)
      ? Math.max(0, nativeResult.frameDurationMs)
      : 0;

  let frames: Float32Array | undefined;
  const framesTransferId =
    typeof nativeResult?.framesTransferId === 'string'
      ? nativeResult.framesTransferId.trim()
      : '';

  if (frameCount > 0 && framesTransferId.length > 0) {
    const expectedFramesLength = frameCount * barCount;
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
    kind: 'spectrum_bars',
    sampleRate,
    durationMs,
    barCount,
    levels,
    frameCount,
    frameDurationMs,
    frames,
  };
}

/**
 * Persist an already-computed profile (destination required on `persist`).
 */
export async function saveAudioVisualizationProfile(
  profile: AudioVisualizationProfile,
  persist: PersistAudioVisualizationProfile
): Promise<SavedAudioVisualizationRef> {
  const normalized = normalizePersist(persist);
  const includeFrames =
    normalized.includeFrames ??
    (profile.frames instanceof Float32Array &&
      profile.frames.length > 0 &&
      profile.frameCount > 0);

  const nativeResult = await SherpaOnnx.saveAudioVisualizationProfile(
    profileToNativePayload(profile, includeFrames) as Object,
    {
      destination: normalized.destination as Object,
      format: normalized.format,
      includeFrames,
      overwrite: normalized.overwrite,
    } as Object
  );

  const outputRaw = (nativeResult as { output?: unknown }).output as
    | { outputKind?: string; outputPath?: string }
    | undefined;

  return {
    format: DEFAULT_FORMAT,
    output: parseResolvedFileRef(outputRaw ?? {}),
    kind: 'spectrum_bars',
    barCount:
      typeof nativeResult?.barCount === 'number'
        ? Math.max(0, Math.trunc(nativeResult.barCount))
        : profile.barCount,
    durationMs:
      typeof nativeResult?.durationMs === 'number'
        ? Math.max(0, nativeResult.durationMs)
        : profile.durationMs,
    sampleRate:
      typeof nativeResult?.sampleRate === 'number'
        ? Math.max(0, Math.trunc(nativeResult.sampleRate))
        : profile.sampleRate,
    hasFrames: nativeResult?.hasFrames === true,
  };
}

function normalizeLoadSource(
  source: LoadAudioVisualizationProfileSource
): FileSource {
  if (isPlainObject(source) && source.kind === 'file') {
    if (!isFileSource(source.source)) {
      throw new Error(
        'AUDIO_VISUALIZATION_INVALID_INPUT: file input requires a valid FileSource'
      );
    }
    return source.source;
  }
  if (!isFileSource(source)) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_INPUT: expected FileSource for load'
    );
  }
  return source;
}

/**
 * Read a visualization sidecar only (no PCM decode).
 */
export async function loadAudioVisualizationProfile(
  source: LoadAudioVisualizationProfileSource,
  options?: LoadAudioVisualizationProfileOptions
): Promise<AudioVisualizationProfile> {
  const fileSource = normalizeLoadSource(source);
  assertFileSourceSupportedOnPlatform(fileSource);

  const nativeResult = await SherpaOnnx.loadAudioVisualizationProfile(
    fileSource as Object,
    {
      strict: options?.strict !== false,
    } as Object
  );

  return mapNativeProfile(nativeResult);
}
