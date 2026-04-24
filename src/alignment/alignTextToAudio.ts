import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolveOfflineSegmentBufferId } from '../segmentbuffer';
import { resolvePipelineTextBufferId } from '../textbuffer';
import type {
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignmentGranularity,
} from './types';

type NativeAlignmentMode = 'proportional' | 'estimated' | 'accurate';
type NativeGranularity = 'sentence' | 'word' | 'character';

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

/**
 * Build alignment segments into a caller-provided offline segment buffer.
 */
export const alignTextToAudio: AlignTextToAudioFn = async (
  textIn,
  audioIn,
  segmentOut,
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
  const segmentOutBufferId = resolveOfflineSegmentBufferId(segmentOut);

  const nativeOptions = buildNativeOptions(options);

  return SherpaOnnx.alignOfflineTextToAudio(
    textInBufferId,
    audioInBufferId,
    segmentOutBufferId,
    mode,
    granularity,
    nativeOptions
  );
};
