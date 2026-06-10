/**
 * Normalizes text before it is passed to sherpa-onnx punctuation models.
 * Online CNN models are trained on lowercase flowing text; ALL-CAPS ASR output
 * degrades punctuation quality without normalization.
 */

export type TextInputNormalization = 'none' | 'lower';

/** Default for streaming CNN and offline CT punctuate paths. */
export const DEFAULT_TEXT_INPUT_NORMALIZATION: TextInputNormalization = 'lower';

export function resolveTextInputNormalization(
  value?: TextInputNormalization | null
): TextInputNormalization {
  if (value === 'none' || value === 'lower') {
    return value;
  }
  return DEFAULT_TEXT_INPUT_NORMALIZATION;
}

export function normalizePunctuationInputText(
  text: string,
  mode: TextInputNormalization = DEFAULT_TEXT_INPUT_NORMALIZATION
): string {
  if (mode === 'none' || text.length === 0) {
    return text;
  }
  return text.toLowerCase();
}
