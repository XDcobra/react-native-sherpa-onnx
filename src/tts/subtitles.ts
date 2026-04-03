import { unlink } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import { WAV2VEC2_VOCAB } from '../alignment/vocab';
import { decodeAudioFileToFloatSamples } from '../audio';
import { saveAlignmentAudioToTempWav } from './tempAudio';
import type {
  SubtitleGranularity,
  SubtitleMode,
  SubtitleFromAudioOptions,
  SubtitleResult,
  TtsSubtitleItem,
} from './types';

export function assertSubtitleGranularityForMode(
  mode: SubtitleMode,
  granularity: SubtitleGranularity
): void {
  if (granularity === 'character' && mode !== 'accurate') {
    throw new Error(
      "Character granularity is only supported when subtitles.mode is 'accurate'."
    );
  }
}

const SENTENCE_TERMINATORS = new Set([
  '.',
  '!',
  '?',
  ';',
  '。',
  '！',
  '？',
  '；',
]);
const TRAILING_CLOSERS = new Set([
  '"',
  "'",
  ')',
  ']',
  '}',
  '>',
  '”',
  '’',
  '」',
  '』',
  '】',
  '）',
]);

const COMMON_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
]);

const WAV2VEC2_VOCAB_JSON = JSON.stringify(WAV2VEC2_VOCAB);

function isWhitespaceChar(char: string): boolean {
  return /\s/u.test(char);
}

function isSentenceTerminator(char: string): boolean {
  return SENTENCE_TERMINATORS.has(char);
}

function isTrailingCloser(char: string): boolean {
  return TRAILING_CLOSERS.has(char);
}

function extractTokenBeforePeriod(text: string, periodIndex: number): string {
  let i = periodIndex - 1;
  while (i >= 0 && isWhitespaceChar(text[i] ?? '')) {
    i -= 1;
  }

  const end = i;
  while (i >= 0) {
    const char = text[i] ?? '';
    if (/\p{L}|\./u.test(char)) {
      i -= 1;
      continue;
    }
    break;
  }

  if (end < i + 1) {
    return '';
  }

  return text.slice(i + 1, end + 1).replace(/\.+$/u, '');
}

function shouldSplitOnPeriod(text: string, periodIndex: number): boolean {
  const prev = text[periodIndex - 1] ?? '';
  const next = text[periodIndex + 1] ?? '';

  // Do not split decimal numbers like 3.14.
  if (/\d/u.test(prev) && /\d/u.test(next)) {
    return false;
  }

  const token = extractTokenBeforePeriod(text, periodIndex).toLowerCase();
  if (COMMON_ABBREVIATIONS.has(token)) {
    return false;
  }

  // Likely initial, e.g. "A. Smith".
  if (token.length === 1 && token.toUpperCase() === token) {
    return false;
  }

  return true;
}

function sentenceBoundaryEnd(text: string, index: number): number {
  let end = index + 1;

  while (end < text.length && isSentenceTerminator(text[end] ?? '')) {
    end += 1;
  }

  while (end < text.length && isTrailingCloser(text[end] ?? '')) {
    end += 1;
  }

  return end;
}

function sanitizeSegments(segments: string[]): string[] {
  return segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function distributeSamplesByTextWeight(
  totalSamples: number,
  segments: string[]
): number[] {
  if (segments.length === 0) {
    return [];
  }

  const safeTotal = Math.max(0, Math.floor(totalSamples));
  if (safeTotal === 0) {
    return new Array(segments.length).fill(0);
  }

  const weights = segments.map((segment) =>
    Math.max(1, Array.from(segment).length)
  );
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (weightSum <= 0) {
    return new Array(segments.length).fill(0);
  }

  const base = weights.map((weight) =>
    Math.floor((safeTotal * weight) / weightSum)
  );

  let assigned = base.reduce((sum, value) => sum + value, 0);
  let remaining = safeTotal - assigned;

  if (remaining > 0) {
    const fractionalOrder = weights
      .map((weight, index) => {
        const exact = (safeTotal * weight) / weightSum;
        return {
          index,
          fraction: exact - Math.floor(exact),
        };
      })
      .sort((a, b) => b.fraction - a.fraction);

    let ptr = 0;
    while (remaining > 0 && fractionalOrder.length > 0) {
      const target = fractionalOrder[ptr % fractionalOrder.length];
      if (target == null) {
        break;
      }
      base[target.index] = (base[target.index] ?? 0) + 1;
      assigned += 1;
      remaining = safeTotal - assigned;
      ptr += 1;
    }
  }

  return base;
}

function alignChunkCountsToSegments(
  segments: string[],
  chunkSampleCounts: number[]
): number[] {
  if (segments.length === 0) {
    return [];
  }

  const counts = chunkSampleCounts.map((value) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  );

  if (counts.length === segments.length) {
    return counts;
  }

  if (counts.length > segments.length) {
    const merged = counts.slice(0, segments.length);
    const extra = counts
      .slice(segments.length)
      .reduce((sum, value) => sum + value, 0);
    const lastIndex = merged.length - 1;
    if (lastIndex >= 0) {
      merged[lastIndex] = (merged[lastIndex] ?? 0) + extra;
    }
    return merged;
  }

  const total = counts.reduce((sum, value) => sum + value, 0);
  return distributeSamplesByTextWeight(total, segments);
}

type AlignmentNativeItem = {
  text: string;
  start: number;
  end: number;
};

function distributeItemCounts(total: number, weights: number[]): number[] {
  if (weights.length === 0) {
    return [];
  }

  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0) {
    return new Array(weights.length).fill(0);
  }

  const safeWeights = weights.map((weight) => Math.max(1, Math.floor(weight)));
  const weightSum = safeWeights.reduce((sum, value) => sum + value, 0);
  if (weightSum <= 0) {
    return new Array(weights.length).fill(0);
  }

  const base = safeWeights.map((weight) =>
    Math.floor((safeTotal * weight) / weightSum)
  );

  let assigned = base.reduce((sum, value) => sum + value, 0);
  let remaining = safeTotal - assigned;
  let index = 0;
  while (remaining > 0 && base.length > 0) {
    const slot = index % base.length;
    base[slot] = (base[slot] ?? 0) + 1;
    assigned += 1;
    remaining = safeTotal - assigned;
    index += 1;
  }

  return base;
}

function normalizeAlignmentItems(
  items: AlignmentNativeItem[]
): TtsSubtitleItem[] {
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

function buildSentenceSubtitlesFromAlignedWords(
  text: string,
  alignedWords: TtsSubtitleItem[]
): TtsSubtitleItem[] {
  const sentences = splitTextIntoSentences(text);
  if (sentences.length === 0 || alignedWords.length === 0) {
    return [];
  }

  const sentenceWeights = sentences.map((sentence) =>
    Math.max(1, splitTextIntoWords(sentence).length)
  );
  const sentenceWordCounts = distributeItemCounts(
    alignedWords.length,
    sentenceWeights
  );

  const subtitles: TtsSubtitleItem[] = [];
  let wordCursor = 0;
  let fallbackTime = alignedWords[0]?.start ?? 0;

  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i] ?? '';
    const count = Math.max(0, sentenceWordCounts[i] ?? 0);
    const chunk = alignedWords.slice(wordCursor, wordCursor + count);
    wordCursor += count;

    if (chunk.length === 0) {
      subtitles.push({
        text: sentence,
        start: fallbackTime,
        end: fallbackTime,
      });
      continue;
    }

    const start = chunk[0]?.start ?? fallbackTime;
    const end = chunk[chunk.length - 1]?.end ?? start;
    fallbackTime = end;

    subtitles.push({
      text: sentence,
      start,
      end,
    });
  }

  const lastAlignedEnd = alignedWords[alignedWords.length - 1]?.end;
  if (lastAlignedEnd !== undefined && subtitles.length > 0) {
    const lastIndex = subtitles.length - 1;
    const last = subtitles[lastIndex];
    if (last != null) {
      subtitles[lastIndex] = {
        ...last,
        end: Math.max(last.end, lastAlignedEnd),
      };
    }
  }

  return subtitles;
}

function isCjkChar(char: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
    char
  );
}

function isWordDelimiter(char: string): boolean {
  return /[\s.,!?;:()[\]{}"'`~<>/\\|@#$%^&*+=…，。！？；：、]/u.test(char);
}

export function splitTextIntoSentences(text: string): string[] {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return [];
  }

  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < normalized.length) {
    const current = normalized[i] ?? '';
    if (!isSentenceTerminator(current)) {
      i += 1;
      continue;
    }

    if (current === '.' && !shouldSplitOnPeriod(normalized, i)) {
      i += 1;
      continue;
    }

    const end = sentenceBoundaryEnd(normalized, i);
    const next = normalized[end];
    if (next !== undefined && !isWhitespaceChar(next)) {
      i += 1;
      continue;
    }

    const sentence = normalized.slice(start, end).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }

    start = end;
    while (
      start < normalized.length &&
      isWhitespaceChar(normalized[start] ?? '')
    ) {
      start += 1;
    }
    i = start;
  }

  const tail = normalized.slice(start).trim();
  if (tail.length > 0) {
    sentences.push(tail);
  }

  return sentences.length > 0 ? sentences : [normalized];
}

export function splitTextIntoWords(text: string): string[] {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return [];
  }

  const words: string[] = [];
  let current = '';

  const flushCurrent = () => {
    const token = current.trim();
    if (token.length > 0) {
      words.push(token);
    }
    current = '';
  };

  for (const char of normalized) {
    if (isWhitespaceChar(char)) {
      flushCurrent();
      continue;
    }

    if (isCjkChar(char)) {
      flushCurrent();
      words.push(char);
      continue;
    }

    if (isWordDelimiter(char)) {
      flushCurrent();
      continue;
    }

    current += char;
  }

  flushCurrent();

  return words.length > 0 ? words : [normalized];
}

export function buildSubtitlesFromChunks(
  segments: string[],
  chunkSampleCounts: number[],
  sampleRate: number
): TtsSubtitleItem[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return [];
  }

  const cleanedSegments = sanitizeSegments(segments);
  if (cleanedSegments.length === 0) {
    return [];
  }

  const alignedCounts = alignChunkCountsToSegments(
    cleanedSegments,
    chunkSampleCounts
  );

  const subtitles: TtsSubtitleItem[] = [];
  let offsetSamples = 0;

  for (let i = 0; i < cleanedSegments.length; i += 1) {
    const samples = Math.max(0, alignedCounts[i] ?? 0);
    if (samples === 0 && offsetSamples === 0) {
      continue;
    }

    const start = offsetSamples / sampleRate;
    offsetSamples += samples;
    const end = offsetSamples / sampleRate;

    subtitles.push({
      text: cleanedSegments[i] ?? '',
      start,
      end,
    });
  }

  return subtitles;
}

/**
 * Generate subtitle timelines from an existing transcript plus audio.
 *
 * This helper supports two modes:
 * - `mode: 'fast'`: single-stage estimation from transcript chunks + audio duration.
 * - `mode: 'accurate'`: two-stage pipeline: external STT transcript + wav2vec2 CTC forced alignment.
 *
 * For accurate mode, an alignment model from `ModelCategory.Alignment` must be available.
 * You can pre-validate a model path via `detectAlignmentModel` from `react-native-sherpa-onnx/alignment`
 * before calling this function.
 *
 * Related exports:
 * - Alignment detection: `detectAlignmentModel`
 */
export async function generateSubtitlesFromAudio(
  text: string,
  audioPathOrSamples: string | { samples: number[]; sampleRate: number },
  options: SubtitleFromAudioOptions
): Promise<SubtitleResult> {
  const mode = options.mode;
  const granularity = options.granularity ?? 'sentence';

  assertSubtitleGranularityForMode(mode, granularity);

  if (mode === 'accurate') {
    const resolvedModelPath = options.alignmentModelPath?.trim();

    if (!resolvedModelPath) {
      throw new Error(
        'ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate subtitles.'
      );
    }

    let audioPath = '';
    let shouldCleanup = false;

    if (typeof audioPathOrSamples === 'string') {
      audioPath = audioPathOrSamples;
    } else {
      audioPath = await saveAlignmentAudioToTempWav(audioPathOrSamples);
      shouldCleanup = true;
    }

    try {
      const aligned = await SherpaOnnx.runCTCForcedAlignment(
        resolvedModelPath,
        audioPath,
        text,
        WAV2VEC2_VOCAB_JSON
      );

      const wordItems = normalizeAlignmentItems(aligned.words ?? []);
      const charItems = normalizeAlignmentItems(aligned.chars ?? []);

      return {
        subtitles:
          granularity === 'character'
            ? charItems
            : granularity === 'word'
            ? wordItems
            : buildSentenceSubtitlesFromAlignedWords(text, wordItems),
        timingMode: 'aligned',
      };
    } finally {
      if (shouldCleanup) {
        unlink(audioPath).catch(() => {
          // ignore cleanup errors
        });
      }
    }
  }

  const segments =
    granularity === 'word'
      ? splitTextIntoWords(text)
      : splitTextIntoSentences(text);

  if (segments.length === 0) {
    return {
      subtitles: [],
      timingMode: 'estimated',
    };
  }

  let totalSamples = 0;
  let sampleRate = 0;

  if (typeof audioPathOrSamples === 'string') {
    const decoded = await decodeAudioFileToFloatSamples(audioPathOrSamples);
    totalSamples = decoded.samples.length;
    sampleRate = decoded.sampleRate;
  } else {
    totalSamples = audioPathOrSamples.samples.length;
    sampleRate = audioPathOrSamples.sampleRate;
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || totalSamples <= 0) {
    return {
      subtitles: [],
      timingMode: 'estimated',
    };
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
    timingMode: 'estimated',
  };
}
