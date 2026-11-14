/**
 * Read-aloud helpers: turn a TTS synthesis timeline into sentence / word
 * ranges of a reader document, and pick the ones being spoken at a playback
 * position. Rendering is `ReaderView` `highlights`; see docs/reader.md.
 */
import { useMemo } from 'react';

import { getOfflineTextBufferTextSlice } from '../textbuffer';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type { TtsTimeline } from '../tts/types';
import { mapTextRanges } from './api';
import type {
  ReaderDocument,
  ReaderHighlight,
  ReaderRange,
  ReaderTextSlice,
} from './types';

/** One spoken sentence or word, mapped onto the reader. */
export type ReadAloudUnit = {
  kind: 'sentence' | 'word';
  /** Position in `sentences` / `words`. */
  index: number;
  /** Index of the sentence this unit belongs to (itself for sentences). */
  sentenceIndex: number;
  range: ReaderRange;
  /** UTF-16 range in the synthesized text (the slice, or the document's text buffer). */
  textStart: number;
  textEnd: number;
  startMs: number;
  endMs: number;
};

export type ReadAloudPosition = {
  sentence: ReadAloudUnit | null;
  word: ReadAloudUnit | null;
};

export type ReadAloudTimeline = {
  durationMs: number;
  sentences: ReadAloudUnit[];
  words: ReadAloudUnit[];
  /** Units being spoken at `ms` (playback position of the synthesized audio). */
  at(ms: number): ReadAloudPosition;
};

/** A word with exact timing, e.g. from `alignTextToAudio` (granularity `word`). */
export type ReadAloudAlignedWord = {
  text: string;
  startSample: number;
  endSample: number;
};

export type CreateReadAloudTimelineOptions = {
  /**
   * The text buffer that was synthesized (the TTS input). Optional with
   * `slice`: its buffer is used.
   */
  text?: OfflineTextBufferIdSource;
  /** `result.timeline` from `tts.synthesize(…, { timeline: true })`. */
  tts: TtsTimeline;
  /**
   * The synthesized text is this slice (`createReaderTextSlice`): any text
   * the reader shows, also OCR text and app sections, across pages.
   */
  slice?: ReaderTextSlice | null;
  /**
   * Without `slice`: where the synthesized text starts in the document's text
   * buffer, when you synthesized a part of it. Default 0.
   */
  textOffset?: number;
  /** Default `'both'`. */
  granularity?: 'sentence' | 'word' | 'both';
  words?: {
    /**
     * `'estimated'` (default): each sentence's duration is spread over its
     * words by text length plus a pause after punctuation. `{ aligned }`:
     * exact word times, matched to the words in order; words without a match
     * keep their estimate.
     */
    timing?: 'estimated' | { aligned: ReadAloudAlignedWord[] };
    /**
     * Word splitter: UTF-16 [start, end) ranges inside a sentence. Default:
     * whitespace-separated words without surrounding punctuation (for
     * languages without spaces, e.g. CJK, pass your own).
     */
    split?: (sentence: string) => Array<[number, number]>;
  };
};

const EDGE_PUNCT = '"\'“”‘’«»„‚‹›()[]{}<>.,;:!?…—–-*_/\\';
const SHORT_PAUSE = ',;:';
const LONG_PAUSE = '.!?…';

/** Default word splitter: whitespace tokens, surrounding punctuation trimmed. */
export function splitWords(sentence: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    let a = m.index;
    let b = a + m[0].length;
    while (a < b && EDGE_PUNCT.includes(sentence[a]!)) a += 1;
    while (b > a && EDGE_PUNCT.includes(sentence[b - 1]!)) b -= 1;
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Relative speaking weight of a word: length in code points plus a pause after punctuation. */
function wordWeight(sentence: string, start: number, end: number): number {
  let w = Array.from(sentence.slice(start, end)).length;
  // Punctuation right after the word (up to the next space) adds a pause.
  let i = end;
  while (i < sentence.length && !/\s/.test(sentence[i]!)) {
    const c = sentence[i]!;
    if (LONG_PAUSE.includes(c)) {
      w += 5;
      break;
    }
    if (SHORT_PAUSE.includes(c)) {
      w += 3;
      break;
    }
    i += 1;
  }
  return Math.max(1, w);
}

function normalizeWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9'À-￿]/g, '');
}

type Pending = {
  kind: 'sentence' | 'word';
  sentenceIndex: number;
  start: number; // UTF-16 in the synthesized text
  end: number;
  startSample: number;
  endSample: number;
};

/**
 * Builds the read-aloud timeline for one synthesis. Units are mapped onto
 * reader locators in one native call (`mapTextRanges`).
 */
export async function createReadAloudTimeline(
  doc: ReaderDocument,
  options: CreateReadAloudTimelineOptions
): Promise<ReadAloudTimeline> {
  const { tts } = options;
  const slice = options.slice ?? null;
  const source = options.text ?? slice?.buffer;
  if (!source) {
    throw Object.assign(
      new Error('ERR_READER_INVALID_ARGUMENT: pass `text` or `slice`'),
      { code: 'ERR_READER_INVALID_ARGUMENT' }
    );
  }
  const base = slice ? 0 : Math.max(0, Math.trunc(options.textOffset ?? 0));
  const granularity = options.granularity ?? 'both';
  const wantWords = granularity !== 'sentence';
  const wantSentences = granularity !== 'word';
  const split = options.words?.split ?? splitWords;
  const rate = tts.sampleRate > 0 ? tts.sampleRate : 1;

  const segments = tts.segments.filter(
    (s) => !s.skipped && s.numSamples > 0 && s.utf16End > s.utf16Start
  );
  const textEnd = segments.reduce((m, s) => Math.max(m, s.utf16End), 0);
  const text =
    textEnd > 0 ? await getOfflineTextBufferTextSlice(source, 0, textEnd) : '';

  const pending: Pending[] = [];
  const wordPending: Pending[] = [];
  let sentenceIndex = 0;
  for (const seg of segments) {
    // Segments are contiguous slices: trim surrounding whitespace for display.
    let a = seg.utf16Start;
    let b = Math.min(seg.utf16End, text.length);
    while (a < b && /\s/.test(text[a]!)) a += 1;
    while (b > a && /\s/.test(text[b - 1]!)) b -= 1;
    if (b <= a) continue;
    const s0 = seg.startSample;
    const s1 = seg.startSample + seg.numSamples;
    const si = sentenceIndex++;
    if (wantSentences) {
      pending.push({
        kind: 'sentence',
        sentenceIndex: si,
        start: a,
        end: b,
        startSample: s0,
        endSample: s1,
      });
    }
    if (!wantWords) continue;
    const sentence = text.slice(a, b);
    const words = split(sentence).filter(
      ([x, y]) => y > x && x >= 0 && y <= sentence.length
    );
    if (words.length === 0) continue;
    const weights = words.map(([x, y]) => wordWeight(sentence, x, y));
    const total = weights.reduce((p, w) => p + w, 0);
    let acc = 0;
    words.forEach(([x, y], i) => {
      const from = s0 + Math.round(((s1 - s0) * acc) / total);
      acc += weights[i]!;
      const to = s0 + Math.round(((s1 - s0) * acc) / total);
      wordPending.push({
        kind: 'word',
        sentenceIndex: si,
        start: a + x,
        end: a + y,
        startSample: from,
        endSample: to,
      });
    });
  }

  const timing = options.words?.timing;
  if (wantWords && timing && timing !== 'estimated') {
    applyAlignedWords(wordPending, text, timing.aligned);
  }

  const all = [...pending, ...wordPending];
  const ranges = await mapTextRanges(
    doc,
    all.map((u) => [base + u.start, base + u.end] as const),
    { slice }
  );

  const sentences: ReadAloudUnit[] = [];
  const words: ReadAloudUnit[] = [];
  all.forEach((u, i) => {
    const range = ranges[i];
    if (!range) return;
    const list = u.kind === 'sentence' ? sentences : words;
    list.push({
      kind: u.kind,
      index: list.length,
      sentenceIndex: u.sentenceIndex,
      range,
      textStart: base + u.start,
      textEnd: base + u.end,
      startMs: (u.startSample / rate) * 1000,
      endMs: (u.endSample / rate) * 1000,
    });
  });

  const durationMs =
    (segments.reduce((m, s) => Math.max(m, s.startSample + s.numSamples), 0) /
      rate) *
    1000;
  return {
    durationMs,
    sentences,
    words,
    at(ms: number): ReadAloudPosition {
      return { sentence: unitAt(sentences, ms), word: unitAt(words, ms) };
    },
  };
}

/** Assigns exact times to estimated words, matching aligned words in order. */
function applyAlignedWords(
  words: Pending[],
  text: string,
  aligned: ReadAloudAlignedWord[]
): void {
  let j = 0;
  for (const unit of aligned) {
    const key = normalizeWord(unit.text);
    if (!key || unit.endSample < unit.startSample) continue;
    // Look a few words ahead so one missing / extra word does not derail the match.
    for (let k = j; k < Math.min(words.length, j + 6); k += 1) {
      const w = words[k]!;
      if (normalizeWord(text.slice(w.start, w.end)) === key) {
        w.startSample = unit.startSample;
        w.endSample = unit.endSample;
        j = k + 1;
        break;
      }
    }
  }
}

/** Last unit that started at or before `ms` and has not ended; null in gaps / outside. */
function unitAt(units: ReadAloudUnit[], ms: number): ReadAloudUnit | null {
  let lo = 0;
  let hi = units.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (units[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const u = units[found]!;
  return ms < u.endMs ? u : null;
}

export type ReadAloudHighlightOptions = {
  /** Default `'both'`. */
  show?: 'sentence' | 'word' | 'both';
  /** Overrides for the sentence highlight (default: background in the accent). */
  sentenceStyle?: Pick<ReaderHighlight, 'style' | 'color'>;
  /** Overrides for the word highlight (default: underline in the accent). */
  wordStyle?: Pick<ReaderHighlight, 'style' | 'color'>;
  /**
   * Which highlight follow scrolling keeps in view. Default: the word when
   * words are shown (so it never runs out of view inside a long sentence),
   * else the sentence.
   */
  follow?: 'sentence' | 'word' | false;
  /** ID prefix (default `readAloud`): IDs are `<prefix>:sentence` / `<prefix>:word`. */
  idPrefix?: string;
};

/**
 * Highlights for the units spoken at `positionMs`. The array only changes when
 * the spoken sentence / word (or the options) change, so the native view is
 * updated at word rate, not at the position callback rate.
 */
export function useReadAloudHighlights(
  timeline: ReadAloudTimeline | null,
  positionMs: number | null,
  options: ReadAloudHighlightOptions = {}
): ReaderHighlight[] {
  const at =
    timeline && positionMs != null
      ? timeline.at(positionMs)
      : { sentence: null, word: null };
  const sentence = at.sentence;
  const word = at.word;
  const show = options.show ?? 'both';
  const follow = options.follow ?? (show === 'sentence' ? 'sentence' : 'word');
  const prefix = options.idPrefix ?? 'readAloud';
  const styleKey = JSON.stringify([options.sentenceStyle, options.wordStyle]);

  return useMemo(() => {
    const out: ReaderHighlight[] = [];
    const showSentence = sentence != null && show !== 'word';
    const showWord = word != null && show !== 'sentence';
    // Follow the requested unit, or the one that is shown.
    let followKind: 'sentence' | 'word' | false = follow;
    if (followKind === 'sentence' && !showSentence) followKind = 'word';
    else if (followKind === 'word' && !showWord) followKind = 'sentence';
    if (sentence && showSentence) {
      out.push({
        id: `${prefix}:sentence`,
        from: sentence.range.from,
        to: sentence.range.to,
        style: options.sentenceStyle?.style ?? 'background',
        ...(options.sentenceStyle?.color != null
          ? { color: options.sentenceStyle.color }
          : {}),
        follow: followKind === 'sentence',
      });
    }
    if (word && showWord) {
      out.push({
        id: `${prefix}:word`,
        from: word.range.from,
        to: word.range.to,
        style: options.wordStyle?.style ?? 'underline',
        ...(options.wordStyle?.color != null
          ? { color: options.wordStyle.color }
          : {}),
        follow: followKind === 'word',
      });
    }
    return out;
    // styleKey stands in for the style objects (often inline literals).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentence, word, show, follow, prefix, styleKey]);
}
