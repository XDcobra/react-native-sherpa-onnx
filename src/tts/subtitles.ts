import { decodeAudioFileToFloatSamples } from '../audio';
import type {
  SubtitleFromAudioOptions,
  SubtitleResult,
  TtsSubtitleItem,
} from './types';

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

export async function generateSubtitlesFromAudio(
  text: string,
  audioPathOrSamples: string | { samples: number[]; sampleRate: number },
  options: SubtitleFromAudioOptions
): Promise<SubtitleResult> {
  const mode = options.mode;
  const granularity = options.granularity ?? 'sentence';

  if (mode === 'accurate') {
    throw new Error(
      "Accurate subtitle mode is not yet implemented. Use 'fast'."
    );
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
