/**
 * Supertonic TTS (v1/v2 bundles, no "3" in the model key) — curated public language hints
 * when native/catalog heuristics return none.
 * https://github.com/supertone-inc/supertonic
 */
export const SUPERTONIC_TTS_ISO6391_HINTS = [
  'en',
  'ko',
  'fr',
  'es',
  'pt',
] as const;

/**
 * True when the catalog id, archive name, or folder basename denotes Supertonic 3
 * (e.g. `sherpa-onnx-supertonic-3-tts-int8-2026-05-11`), not legacy Supertonic bundles
 * (`sherpa-onnx-supertonic-tts-int8-2026-03-06`).
 */
export function isSupertonic3ModelKey(modelKey: string | undefined): boolean {
  if (!modelKey?.trim()) {
    return false;
  }
  const lower = modelKey.trim().toLowerCase();
  if (!lower.includes('supertonic')) {
    return false;
  }
  return (
    lower.includes('supertonic-3') ||
    lower.includes('supertonic_3') ||
    lower.includes('supertonic-v3') ||
    /supertonic3(?:[_\-.]|$)/.test(lower)
  );
}
