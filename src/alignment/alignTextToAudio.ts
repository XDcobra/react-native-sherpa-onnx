import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolvePipelineTextBufferId } from '../textbuffer';
import type {
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignTextToAudioResult,
  AlignmentGranularity,
  AlignmentTimingMode,
  SubtitleTimingItem,
} from './types';

type NativeAlignmentMode = 'proportional' | 'estimated' | 'accurate';
type NativeGranularity = 'sentence' | 'word' | 'character';

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
  const language =
    typeof options.language === 'string' ? options.language.trim() : '';

  if (options.mode === 'accurate') {
    const alignmentModelPath = options.alignmentModelPath?.trim();
    if (!alignmentModelPath) {
      throw new Error(
        'ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.'
      );
    }
    return {
      alignmentModelPath,
      ...(language.length > 0 ? { language } : {}),
    };
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
      ...(language.length > 0 ? { language } : {}),
    };
  }

  return language.length > 0 ? { language } : {};
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

/**
 * Build subtitle timelines from offline text/audio buffers by delegating all modes to native.
 */
export const alignTextToAudio: AlignTextToAudioFn = async (
  textIn,
  audioIn,
  options
) => {
  const mode = toNativeMode(options.mode);
  const granularity = normalizeGranularity(options.granularity);
  assertAlignmentGranularityForMode(
    mode === 'accurate' ? 'aligned' : mode,
    granularity
  );

  const textInBufferId = resolvePipelineTextBufferId(textIn);
  const audioInBufferId = resolvePipelineAudioBufferId(audioIn);

  const nativeOptions = buildNativeOptions(options);

  const raw = await SherpaOnnx.alignOfflineTextToAudio(
    textInBufferId,
    audioInBufferId,
    mode,
    granularity,
    nativeOptions
  );

  return normalizeAlignmentResult(mode, raw);
};
