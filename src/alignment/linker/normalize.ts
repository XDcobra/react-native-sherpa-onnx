import type { LinkerGranularity } from './types';

export interface TokenSpan {
  raw: string;
  normalized: string;
  startCharIndex: number;
  endCharIndex: number;
}

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const NON_ALNUM_PATTERN = /[^\p{L}\p{N}]+/gu;

function toLocaleLower(text: string, language?: string): string {
  if (language && language.trim().length > 0) {
    return text.toLocaleLowerCase(language);
  }
  return text.toLocaleLowerCase();
}

export function normalizeComparableToken(
  token: string,
  language?: string
): string {
  const prepared = token.replace(/▁/g, ' ').normalize('NFKC').trim();
  const lowered = toLocaleLower(prepared, language);
  return lowered.replace(NON_ALNUM_PATTERN, '');
}

function collectRegexTokenSpans(
  text: string,
  pattern: RegExp,
  language?: string
): TokenSpan[] {
  const spans: TokenSpan[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match != null) {
    const raw = match[0] ?? '';
    const startCharIndex = match.index;
    const endCharIndex = startCharIndex + raw.length;
    const normalized = normalizeComparableToken(raw, language);
    if (normalized.length > 0) {
      spans.push({
        raw,
        normalized,
        startCharIndex,
        endCharIndex,
      });
    }
    match = pattern.exec(text);
  }
  return spans;
}

function collectWhitespaceTokenSpans(
  text: string,
  language?: string
): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/u.test(text[i] ?? '')) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    const start = i;
    while (i < text.length && !/\s/u.test(text[i] ?? '')) {
      i += 1;
    }
    const end = i;
    const raw = text.slice(start, end);
    const normalized = normalizeComparableToken(raw, language);
    if (normalized.length > 0) {
      spans.push({
        raw,
        normalized,
        startCharIndex: start,
        endCharIndex: end,
      });
    }
  }
  return spans;
}

export function tokenizeReferenceText(
  text: string,
  granularity: LinkerGranularity,
  language?: string
): TokenSpan[] {
  if (granularity === 'word') {
    return collectRegexTokenSpans(text, WORD_PATTERN, language);
  }
  return collectWhitespaceTokenSpans(text, language);
}

export interface HypothesisTokenSpan {
  raw: string;
  normalized: string;
  index: number;
  startMs: number;
  endMs: number;
  startCharIndex: number;
  endCharIndex: number;
}

export function buildHypothesisTokenSpans(
  tokens: string[],
  timestampsSec: number[],
  language?: string
): HypothesisTokenSpan[] {
  const spans: HypothesisTokenSpan[] = [];
  let cursor = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i] ?? '';
    const normalized = normalizeComparableToken(raw, language);
    if (normalized.length === 0) {
      continue;
    }

    const startSec = Number(timestampsSec[i]);
    const nextSec = Number(timestampsSec[i + 1]);
    const startMs = Number.isFinite(startSec)
      ? Math.max(0, startSec * 1000)
      : 0;
    const fallbackEnd = startMs + 120;
    const endMs =
      Number.isFinite(nextSec) && nextSec * 1000 > startMs
        ? nextSec * 1000
        : fallbackEnd;

    const startCharIndex = cursor;
    const endCharIndex = startCharIndex + raw.length;
    spans.push({
      raw,
      normalized,
      index: i,
      startMs,
      endMs,
      startCharIndex,
      endCharIndex,
    });
    cursor = endCharIndex + 1;
  }

  return spans;
}
