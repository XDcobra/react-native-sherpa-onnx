import type { Romanizer } from './types';

/**
 * Latin / diacritic normalizer for models that need ASCII-romanized input
 * (MMS FA). NFC + compatibility decomposition, then strip combining marks.
 *
 * Does **not** transliterate non-Latin scripts (Arabic, CJK, Cyrillic, …).
 * Those require a future uroman-class backend behind the same {@link Romanizer}
 * interface.
 */
export const latinDiacriticRomanizer: Romanizer = {
  id: 'latin_diacritic',
  romanize(text: string): string {
    if (!text) {
      return text;
    }
    // NFKD expands compatibility forms and separates base + combining marks.
    const decomposed = text.normalize('NFKD');
    // Strip combining marks (Mn). Keep letters/digits/punctuation/whitespace.

    const stripped = decomposed.replace(/\p{M}+/gu, '');
    return stripped.normalize('NFC');
  },
};
