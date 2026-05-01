import type {
  ChunkedForcedCtcCursorState,
  ChunkedForcedCtcCursorUnit,
  ChunkedForcedCtcCursorWindow,
} from './types';

const WORD_WINDOW_MIN_UNITS = 3;
const WORD_WINDOW_MAX_UNITS = 48;
const WORD_TARGET_MS_PER_UNIT = 320;

const SENTENCE_WINDOW_MIN_UNITS = 1;
const SENTENCE_WINDOW_MAX_UNITS = 8;
const SENTENCE_TARGET_MS_PER_UNIT = 1800;

const WINDOW_SAFETY_OVERLAP_UNITS = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function splitWordUnits(sourceText: string): ChunkedForcedCtcCursorUnit[] {
  const units: ChunkedForcedCtcCursorUnit[] = [];
  const wordRegex = /\S+/g;
  let match = wordRegex.exec(sourceText);
  while (match != null) {
    const text = match[0] ?? '';
    const startCharIndex = match.index;
    const endCharIndex = startCharIndex + text.length;
    if (text.trim().length > 0) {
      units.push({ text, startCharIndex, endCharIndex });
    }
    match = wordRegex.exec(sourceText);
  }
  return units;
}

function splitSentenceUnits(sourceText: string): ChunkedForcedCtcCursorUnit[] {
  const units: ChunkedForcedCtcCursorUnit[] = [];

  let segmentStart = 0;
  const n = sourceText.length;
  for (let i = 0; i < n; i += 1) {
    const ch = sourceText[i];
    const isTerminal = ch === '.' || ch === '!' || ch === '?';
    const isLast = i === n - 1;
    if (!isTerminal && !isLast) {
      continue;
    }

    const endExclusive = isLast ? n : i + 1;
    const raw = sourceText.slice(segmentStart, endExclusive);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const trimmedLength = raw.length - leading - trailing;

    if (trimmedLength > 0) {
      const startCharIndex = segmentStart + leading;
      const endCharIndex = startCharIndex + trimmedLength;
      units.push({
        text: sourceText.slice(startCharIndex, endCharIndex),
        startCharIndex,
        endCharIndex,
      });
    }

    segmentStart = endExclusive;
  }

  return units;
}

function resolveWindowUnitCount(
  granularity: 'sentence' | 'word',
  anchorDurationMs: number
): number {
  const safeDurationMs = Number.isFinite(anchorDurationMs)
    ? Math.max(0, anchorDurationMs)
    : 0;

  if (granularity === 'word') {
    const baseUnits = Math.ceil(safeDurationMs / WORD_TARGET_MS_PER_UNIT);
    const withOverlap = baseUnits + WINDOW_SAFETY_OVERLAP_UNITS;
    return clamp(withOverlap, WORD_WINDOW_MIN_UNITS, WORD_WINDOW_MAX_UNITS);
  }

  const baseUnits = Math.ceil(safeDurationMs / SENTENCE_TARGET_MS_PER_UNIT);
  const withOverlap = baseUnits + 1;
  return clamp(
    withOverlap,
    SENTENCE_WINDOW_MIN_UNITS,
    SENTENCE_WINDOW_MAX_UNITS
  );
}

function windowFromRange(
  cursor: ChunkedForcedCtcCursorState,
  startUnitIndex: number,
  endUnitIndex: number
): ChunkedForcedCtcCursorWindow {
  if (startUnitIndex >= endUnitIndex) {
    return {
      text: '',
      startUnitIndex,
      endUnitIndex,
      unitCount: 0,
      startCharIndex: 0,
      endCharIndex: 0,
    };
  }

  const startUnit = cursor.units[startUnitIndex];
  const endUnit = cursor.units[endUnitIndex - 1];
  if (startUnit == null || endUnit == null) {
    return {
      text: '',
      startUnitIndex,
      endUnitIndex,
      unitCount: 0,
      startCharIndex: 0,
      endCharIndex: 0,
    };
  }

  const startCharIndex = startUnit.startCharIndex;
  const endCharIndex = endUnit.endCharIndex;
  return {
    text: cursor.sourceText.slice(startCharIndex, endCharIndex).trim(),
    startUnitIndex,
    endUnitIndex,
    unitCount: endUnitIndex - startUnitIndex,
    startCharIndex,
    endCharIndex,
  };
}

export function createChunkedForcedCtcCursor(
  sourceText: string,
  granularity: 'sentence' | 'word'
): ChunkedForcedCtcCursorState {
  const normalized = sourceText.trim();
  const units =
    granularity === 'word'
      ? splitWordUnits(normalized)
      : splitSentenceUnits(normalized);

  return {
    sourceText: normalized,
    units,
    cursorIndex: 0,
    granularity,
  };
}

export function getRemainingUnitCount(
  cursor: ChunkedForcedCtcCursorState
): number {
  return Math.max(0, cursor.units.length - cursor.cursorIndex);
}

export function isCursorExhausted(
  cursor: ChunkedForcedCtcCursorState
): boolean {
  return getRemainingUnitCount(cursor) === 0;
}

export function peekCursorWindow(
  cursor: ChunkedForcedCtcCursorState,
  anchorDurationMs: number
): ChunkedForcedCtcCursorWindow {
  if (isCursorExhausted(cursor)) {
    return {
      text: '',
      startUnitIndex: cursor.cursorIndex,
      endUnitIndex: cursor.cursorIndex,
      unitCount: 0,
      startCharIndex: 0,
      endCharIndex: 0,
    };
  }

  const maxUnits = resolveWindowUnitCount(cursor.granularity, anchorDurationMs);
  const startUnitIndex = cursor.cursorIndex;
  const endUnitIndex = Math.min(cursor.units.length, startUnitIndex + maxUnits);
  return windowFromRange(cursor, startUnitIndex, endUnitIndex);
}

export function peekCursorPrefix(
  cursor: ChunkedForcedCtcCursorState,
  consumedUnitCount: number
): ChunkedForcedCtcCursorWindow {
  const safeCount = Number.isFinite(consumedUnitCount)
    ? Math.max(0, Math.trunc(consumedUnitCount))
    : 0;
  if (safeCount === 0 || isCursorExhausted(cursor)) {
    return {
      text: '',
      startUnitIndex: cursor.cursorIndex,
      endUnitIndex: cursor.cursorIndex,
      unitCount: 0,
      startCharIndex: 0,
      endCharIndex: 0,
    };
  }

  const startUnitIndex = cursor.cursorIndex;
  const endUnitIndex = Math.min(
    cursor.units.length,
    startUnitIndex + safeCount
  );
  return windowFromRange(cursor, startUnitIndex, endUnitIndex);
}

export function advanceCursor(
  cursor: ChunkedForcedCtcCursorState,
  consumedUnitCount: number
): number {
  const safeCount = Number.isFinite(consumedUnitCount)
    ? Math.max(0, Math.trunc(consumedUnitCount))
    : 0;
  const next = Math.min(cursor.units.length, cursor.cursorIndex + safeCount);
  const advanced = next - cursor.cursorIndex;
  cursor.cursorIndex = next;
  return advanced;
}
