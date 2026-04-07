import SherpaOnnx from '../NativeSherpaOnnx';
import { WAV2VEC2_VOCAB } from './vocab';
import { decodeAudioFileToFloatSamples } from '../audio';
import type {
  AlignTextToAudioOptions,
  AlignTextToAudioResult,
  AlignmentGranularity,
  SubtitleTimingItem,
} from './types';
import {
  alignChunkCountsToSegments,
  buildSentenceSubtitlesFromAlignedWords,
  buildSubtitlesFromChunks,
  distributeSamplesByTextWeight,
  splitTextIntoSentences,
  splitTextIntoWords,
} from './textSegments';

const WAV2VEC2_VOCAB_JSON = JSON.stringify(WAV2VEC2_VOCAB);

function normalizeAlignmentItems(
  items: Array<{ text: string; start: number; end: number }>
): SubtitleTimingItem[] {
  return items
    .map((item) => ({
      text: item.text,
      start: Number.isFinite(item.start) ? Math.max(0, item.start) : 0,
      end: Number.isFinite(item.end) ? Math.max(0, item.end) : 0,
    }))
    .map((item) => ({
      ...item,
      end: item.end < item.start ? item.start : item.end,
    }))
    .filter((item) => item.text.trim().length > 0);
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

function segmentsForGranularity(
  text: string,
  granularity: 'sentence' | 'word'
): string[] {
  return granularity === 'word'
    ? splitTextIntoWords(text)
    : splitTextIntoSentences(text);
}

function isLikelyWavPath(p: string): boolean {
  return p.trim().toLowerCase().endsWith('.wav');
}

/**
 * Build subtitle timelines from a transcript plus audio (file path or float PCM buffer).
 *
 * - **proportional**: spread total duration by text weight (no model, no engine chunks).
 * - **estimated**: use {@link import('./types').AlignmentChunkTimeline} from TTS synthesis, STT, etc.
 * - **accurate**: wav2vec2 CTC forced alignment (`alignAccurateFromPath` / `alignAccurateFromFloat32`).
 */
export async function alignTextToAudio(
  text: string,
  audioPathOrSamples: string | { samples: number[]; sampleRate: number },
  options: AlignTextToAudioOptions
): Promise<AlignTextToAudioResult> {
  if (options.mode === 'accurate') {
    const g: AlignmentGranularity = options.granularity ?? 'sentence';
    assertAlignmentGranularityForMode('aligned', g);
    const resolvedModelPath = options.alignmentModelPath?.trim();
    if (!resolvedModelPath) {
      throw new Error(
        'ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.'
      );
    }

    let aligned: {
      words: Array<{ text: string; start: number; end: number }>;
      chars: Array<{ text: string; start: number; end: number }>;
    };

    if (typeof audioPathOrSamples === 'string') {
      aligned = await SherpaOnnx.alignAccurateFromPath(
        resolvedModelPath,
        audioPathOrSamples,
        text,
        WAV2VEC2_VOCAB_JSON
      );
    } else {
      aligned = await SherpaOnnx.alignAccurateFromFloat32(
        resolvedModelPath,
        audioPathOrSamples.samples,
        audioPathOrSamples.sampleRate,
        text,
        WAV2VEC2_VOCAB_JSON
      );
    }

    const wordItems = normalizeAlignmentItems(aligned.words ?? []);
    const charItems = normalizeAlignmentItems(aligned.chars ?? []);

    const subtitles: SubtitleTimingItem[] =
      g === 'character'
        ? charItems
        : g === 'word'
        ? wordItems
        : buildSentenceSubtitlesFromAlignedWords(text, wordItems);

    return {
      subtitles,
      timingMode: 'aligned',
    };
  }

  if (options.mode === 'estimated') {
    const g = options.granularity ?? 'sentence';
    assertAlignmentGranularityForMode('estimated', g);
    const { chunks } = options;
    const segs = segmentsForGranularity(text, g);
    if (segs.length === 0) {
      return { subtitles: [], timingMode: 'estimated' };
    }

    const alignedCounts = alignChunkCountsToSegments(segs, [
      ...chunks.segmentSampleCounts,
    ]);

    return {
      subtitles: buildSubtitlesFromChunks(
        segs,
        alignedCounts,
        chunks.sampleRate
      ),
      timingMode: 'estimated',
    };
  }

  if (options.mode !== 'proportional') {
    throw new Error('alignTextToAudio: unreachable mode');
  }

  const g = options.granularity ?? 'sentence';
  assertAlignmentGranularityForMode('proportional', g);
  const segments = segmentsForGranularity(text, g);
  if (segments.length === 0) {
    return { subtitles: [], timingMode: 'proportional' };
  }

  let totalSamples = 0;
  let sampleRate = 0;

  if (typeof audioPathOrSamples === 'string') {
    if (isLikelyWavPath(audioPathOrSamples)) {
      try {
        const m = await SherpaOnnx.getAlignmentAudioMetrics(audioPathOrSamples);
        totalSamples = m.totalSamples;
        sampleRate = m.sampleRate;
      } catch {
        const decoded = await decodeAudioFileToFloatSamples(audioPathOrSamples);
        totalSamples = decoded.samples.length;
        sampleRate = decoded.sampleRate;
      }
    } else {
      const decoded = await decodeAudioFileToFloatSamples(audioPathOrSamples);
      totalSamples = decoded.samples.length;
      sampleRate = decoded.sampleRate;
    }
  } else {
    totalSamples = audioPathOrSamples.samples.length;
    sampleRate = audioPathOrSamples.sampleRate;
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || totalSamples <= 0) {
    return { subtitles: [], timingMode: 'proportional' };
  }

  const chunkSampleCounts = distributeSamplesByTextWeight(
    totalSamples,
    segments
  );

  return {
    subtitles: buildSubtitlesFromChunks(
      segments,
      chunkSampleCounts,
      sampleRate
    ),
    timingMode: 'proportional',
  };
}
