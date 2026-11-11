/**
 * Whisper multilingual model ids eligible for Spoken Language Identification.
 * Mirrors {@link isAssetSupportedForCategory} for {@link ModelCategory.LanguageId}.
 */
export function isLanguageIdWhisperModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (!lower.includes('whisper')) {
    return false;
  }
  if (
    lower.includes('.en.') ||
    lower.endsWith('.en') ||
    lower.includes('aishell')
  ) {
    return false;
  }
  return true;
}

export function filterLanguageIdWhisperModels<T extends { id: string }>(
  models: readonly T[]
): T[] {
  return models.filter((model) => isLanguageIdWhisperModelId(model.id));
}
