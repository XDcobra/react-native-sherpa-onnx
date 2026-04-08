import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  AlignAudioInput,
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignTextToAudioResult,
  AlignTextToTtsSinkFn,
  AlignmentGranularity,
  AlignmentTimingMode,
  SubtitleTimingItem,
} from './types';

type NativeAlignmentMode = 'proportional' | 'estimated' | 'accurate';
type NativeGranularity = 'sentence' | 'word' | 'character';
type NativeTtsSinkHandle = {
  generation: number;
  _instanceId?: string;
  instanceId?: string;
};

function normalizeAlignmentItems(
  items: Array<{ text: string; start: number; end: number }> | null | undefined
): SubtitleTimingItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      text: typeof item.text === 'string' ? item.text : '',
      start: Number.isFinite(item.start) ? Math.max(0, item.start) : 0,
      end: Number.isFinite(item.end) ? Math.max(0, item.end) : 0,
    }))
    .map((item) => ({
      ...item,
      end: item.end < item.start ? item.start : item.end,
    }))
    .filter((item) => item.text.trim().length > 0);
}

function expectedTimingMode(mode: NativeAlignmentMode): AlignmentTimingMode {
  if (mode === 'accurate') {
    return 'aligned';
  }
  return mode;
}

function normalizeTimingMode(
  mode: NativeAlignmentMode,
  rawTimingMode: unknown
): AlignmentTimingMode {
  if (
    rawTimingMode === 'proportional' ||
    rawTimingMode === 'estimated' ||
    rawTimingMode === 'aligned'
  ) {
    return rawTimingMode;
  }
  return expectedTimingMode(mode);
}

function normalizeGranularity(
  granularity: AlignmentGranularity | undefined
): NativeGranularity {
  if (granularity === 'word' || granularity === 'character') {
    return granularity;
  }
  return 'sentence';
}

/**
 * Character granularity requires accurate (CTC) mode.
 */
export function assertAlignmentGranularityForMode(
  mode: 'proportional' | 'estimated' | 'aligned' | 'off',
  granularity: AlignmentGranularity
): void {
  if (granularity === 'character' && mode !== 'aligned') {
    throw new Error(
      "Character granularity is only supported when alignment mode is 'accurate' (CTC)."
    );
  }
}

function toNativeMode(
  mode: AlignTextToAudioOptions['mode']
): NativeAlignmentMode {
  if (mode === 'proportional' || mode === 'estimated' || mode === 'accurate') {
    return mode;
  }
  throw new Error(`Unsupported alignment mode: ${String(mode)}`);
}

function buildNativeOptions(
  options: AlignTextToAudioOptions
): Record<string, unknown> {
  if (options.mode === 'accurate') {
    const alignmentModelPath = options.alignmentModelPath?.trim();
    if (!alignmentModelPath) {
      throw new Error(
        'ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.'
      );
    }
    return { alignmentModelPath };
  }

  if (options.mode === 'estimated') {
    const segmentSampleCounts = options.chunks.segmentSampleCounts.map(
      (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return 0;
        }
        return Math.max(0, Math.round(n));
      }
    );

    return {
      segmentSampleCounts,
      chunks: {
        sampleRate: options.chunks.sampleRate,
        segmentSampleCounts,
      },
    };
  }

  return {};
}

function normalizeAlignmentResult(
  mode: NativeAlignmentMode,
  raw: {
    subtitles?: Array<{ text: string; start: number; end: number }>;
    timingMode?: unknown;
  }
): AlignTextToAudioResult {
  return {
    subtitles: normalizeAlignmentItems(raw.subtitles),
    timingMode: normalizeTimingMode(mode, raw.timingMode),
  };
}

function toSamplesArray(audio: AlignAudioInput): number[] {
  if (typeof audio === 'string') {
    return [];
  }

  const { samples } = audio;
  if (samples instanceof Float32Array) {
    return Array.from(samples);
  }

  // Runtime fallback for callers still passing number[].
  return Array.from(samples as unknown as ArrayLike<number>);
}

/**
 * Build subtitle timelines from transcript + audio by delegating all modes to native.
 */
export const alignTextToAudio: AlignTextToAudioFn = async (
  text,
  audio,
  options
) => {
  const mode = toNativeMode(options.mode);
  const granularity = normalizeGranularity(options.granularity);
  assertAlignmentGranularityForMode(
    mode === 'accurate' ? 'aligned' : mode,
    granularity
  );

  const nativeOptions = buildNativeOptions(options);

  if (typeof audio === 'string') {
    const raw = await SherpaOnnx.alignTextToAudioFromPath(
      text,
      audio,
      mode,
      granularity,
      nativeOptions
    );
    return normalizeAlignmentResult(mode, raw);
  }

  const raw = await SherpaOnnx.alignTextToAudioFromPcm(
    text,
    toSamplesArray(audio),
    audio.sampleRate,
    mode,
    granularity,
    nativeOptions
  );

  return normalizeAlignmentResult(mode, raw);
};

/**
 * Align directly from native TTS sink data (no PCM round-trip through JS).
 */
export const alignTextToTtsSink: AlignTextToTtsSinkFn = async (
  text,
  generatedAudio,
  options
) => {
  const mode = toNativeMode(options.mode);
  const granularity = normalizeGranularity(options.granularity);
  assertAlignmentGranularityForMode(
    mode === 'accurate' ? 'aligned' : mode,
    granularity
  );

  const nativeOptions = buildNativeOptions(options);
  const source = generatedAudio as unknown as NativeTtsSinkHandle;
  const privateId =
    typeof source._instanceId === 'string' ? source._instanceId.trim() : '';
  const publicId =
    typeof source.instanceId === 'string' ? source.instanceId.trim() : '';
  const instanceId = privateId.length > 0 ? privateId : publicId || null;
  if (instanceId == null) {
    throw new Error(
      'ALIGNMENT_TTS_HANDLE_MISSING: alignTextToTtsSink expects GeneratedAudio returned by createTTS.generateSpeech().'
    );
  }

  const handle: NativeTtsSinkHandle = {
    generation: generatedAudio.generation,
    _instanceId: instanceId,
  };

  const raw = await SherpaOnnx.alignTextToTtsSink(
    handle,
    text,
    mode,
    granularity,
    nativeOptions
  );

  return normalizeAlignmentResult(mode, raw);
};
