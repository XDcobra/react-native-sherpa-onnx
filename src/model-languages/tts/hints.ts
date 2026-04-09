/**
 * Optional TTS-side language hints when native folder/catalog heuristics return no tags.
 * Extend per TTS architecture when you add curated lists under `model-languages/tts/`.
 */
export function iso6391HintsForTtsModelType(
  _modelType: string | undefined
): string[] | undefined {
  return undefined;
}
