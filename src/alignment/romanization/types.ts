/**
 * Pluggable romanization for alignment transcripts.
 *
 * Some char-CTC models (e.g. MMS FA) expect romanized Latin input; others
 * (VoxPopuli, EN-960h, XLSR for Latin scripts) keep native/diacritic text.
 * Non-Latin scripts use the `uroman` backend behind the same interface.
 */
export interface Romanizer {
  readonly id: string;
  romanize(text: string, language?: string): string;
}
