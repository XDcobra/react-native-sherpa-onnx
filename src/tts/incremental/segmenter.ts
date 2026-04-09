import type { SegmentationPolicy } from './types';

// Default boundary characters: sentence-ending punctuation across common locales
const DEFAULT_BOUNDARY_CHARS = '.!?;。！？；…\n';

// ---------------------------------------------------------------------------
// Resolved policy (all fields required, with defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedSegmentationPolicy {
  boundaryChars: Set<string>;
  maxCharsPerSegment: number;
  maxWaitMs: number;
  minCharsPerSegment: number;
  debounceMs: number;
}

export function resolveSegmentationPolicy(
  policy?: SegmentationPolicy
): ResolvedSegmentationPolicy {
  return {
    boundaryChars: new Set(
      (policy?.boundaryChars ?? DEFAULT_BOUNDARY_CHARS).split('')
    ),
    maxCharsPerSegment: policy?.maxCharsPerSegment ?? 500,
    maxWaitMs: policy?.maxWaitMs ?? 2000,
    minCharsPerSegment: policy?.minCharsPerSegment ?? 20,
    debounceMs: policy?.debounceMs ?? 100,
  };
}

// ---------------------------------------------------------------------------
// Boundary detection result
// ---------------------------------------------------------------------------

export interface SegmentBoundary {
  /** Text of the segment to commit. */
  text: string;
  /** Remaining text after the boundary. */
  remainder: string;
  /** Why the boundary was detected. */
  reason: 'punctuation' | 'max-length' | 'timeout' | 'forced';
}

// ---------------------------------------------------------------------------
// Core boundary detector (pure function — timers handled by engine)
// ---------------------------------------------------------------------------

/**
 * Scan buffered text for segment boundaries.
 * Returns zero or more segments ready to commit.
 *
 * For timer-based boundaries (`timeout`), the engine calls this with
 * `options.forced = true` when the wait timer fires.
 */
export function detectBoundaries(
  buffer: string,
  policy: ResolvedSegmentationPolicy,
  options?: { forced?: boolean; reason?: 'timeout' | 'forced' }
): SegmentBoundary[] {
  if (buffer.length === 0) return [];

  // Forced commit (explicit commit(), flush(), or timeout)
  if (options?.forced) {
    const reason = options.reason ?? 'forced';
    return [{ text: buffer, remainder: '', reason }];
  }

  const results: SegmentBoundary[] = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    // --- max-length boundary ---
    if (remaining.length > policy.maxCharsPerSegment) {
      const searchEnd = policy.maxCharsPerSegment;
      let splitAt = -1;

      // Search backwards from limit for a boundary char
      for (let i = searchEnd - 1; i >= policy.minCharsPerSegment; i--) {
        if (policy.boundaryChars.has(remaining[i]!)) {
          splitAt = i + 1;
          break;
        }
      }

      // Fallback: split at last space near the limit
      if (splitAt === -1) {
        for (let i = searchEnd - 1; i >= policy.minCharsPerSegment; i--) {
          if (remaining[i] === ' ') {
            splitAt = i + 1;
            break;
          }
        }
      }

      // Hard split at max chars as last resort
      if (splitAt === -1) {
        splitAt = searchEnd;
      }

      const text = remaining.slice(0, splitAt).trim();
      remaining = remaining.slice(splitAt);
      if (text.length > 0) {
        results.push({ text, remainder: remaining, reason: 'max-length' });
      }
      continue;
    }

    // --- punctuation boundary ---
    // Find the first boundary char that satisfies minCharsPerSegment.
    // ASCII boundary chars (like '.') require trailing whitespace or end-of-string
    // to avoid splitting tokens like "3.14". Non-ASCII boundary chars (CJK
    // punctuation like '。') and whitespace-class boundary chars ('\n') are
    // accepted unconditionally.
    let boundaryAt = -1;
    for (
      let i = Math.max(0, policy.minCharsPerSegment - 1);
      i < remaining.length;
      i++
    ) {
      if (policy.boundaryChars.has(remaining[i]!)) {
        const code = remaining.charCodeAt(i);
        const isAsciiPunct = code < 128 && code !== 10; /* \n */

        if (!isAsciiPunct) {
          // Non-ASCII boundary (CJK punctuation etc.) — always accept
          boundaryAt = i + 1;
          break;
        }

        // ASCII boundary — require trailing whitespace or end-of-string
        const next = remaining[i + 1];
        if (
          next === undefined ||
          next === ' ' ||
          next === '\n' ||
          next === '\t' ||
          next === '\r'
        ) {
          boundaryAt = i + 1;
          break;
        }
      }
    }

    if (boundaryAt > 0) {
      const text = remaining.slice(0, boundaryAt).trim();
      remaining = remaining.slice(boundaryAt).trimStart();
      if (text.length > 0) {
        results.push({ text, remainder: remaining, reason: 'punctuation' });
      }
      continue;
    }

    // No boundary found — text stays in buffer for now
    break;
  }

  return results;
}
