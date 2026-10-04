import type { RomanizerId } from './registry';

export type VocabRomanizerInference = {
  needsRomanization: boolean;
  romanizerId: Extract<RomanizerId, 'uroman' | 'identity'>;
};

function isSkippedSpecialToken(token: string): boolean {
  const t = token.trim();
  if (!t || t === '|') {
    return true;
  }
  if (t.startsWith('<') || t.startsWith('[')) {
    return true;
  }
  // Pure digits / punctuation-only tokens are not letter vocabulary.
  if (/^[\d\s'’‘\-_.!,?;:]+$/u.test(t)) {
    return true;
  }
  return false;
}

function isLetterToken(token: string): boolean {
  if (isSkippedSpecialToken(token)) {
    return false;
  }
  return /\p{L}/u.test(token);
}

/**
 * Infer whether a char-CTC vocab expects ASCII-romanized input (uroman)
 * vs native-script / diacritic letters (identity).
 *
 * - Any letter char outside ASCII a–z / A–Z → identity
 * - Letter tokens are ASCII a–z / A–Z only → uroman
 * - No letter tokens → identity
 */
export function inferRomanizerFromVocabTokens(
  tokens: Iterable<string>
): VocabRomanizerInference {
  let sawLetter = false;
  for (const token of tokens) {
    if (!isLetterToken(token)) {
      continue;
    }
    sawLetter = true;
    for (const ch of token) {
      if (/\p{L}/u.test(ch) && !/^[a-zA-Z]$/.test(ch)) {
        return { needsRomanization: false, romanizerId: 'identity' };
      }
    }
  }
  if (!sawLetter) {
    return { needsRomanization: false, romanizerId: 'identity' };
  }
  return { needsRomanization: true, romanizerId: 'uroman' };
}

/**
 * Parse a flat HF-style vocab.json object (`token -> id`) into token strings.
 * Returns null when the payload is not a plain object map.
 */
export function tokensFromVocabJson(raw: unknown): string[] | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return Object.keys(raw as Record<string, unknown>);
}
