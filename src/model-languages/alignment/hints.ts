/**
 * Optional alignment-side language hints when native folder/catalog heuristics return no tags.
 *
 * TODO(multilang-alignment): remove English-only assumption when wav2vec/MMS multilang ships.
 */
export function iso6391HintsForAlignmentModelType(
  modelType: string | undefined,
  modelKey?: string
): string[] | undefined {
  const type = (modelType ?? '').trim().toLowerCase();
  const key = (modelKey ?? '').trim().toLowerCase();

  if (type === 'wav2vec2') {
    return ['en'];
  }

  // Name-only catalog detect often reports modelType unknown/auto for alignment packs.
  if (
    key.includes('wav2vec') ||
    key.includes('960h') ||
    type === 'auto'
  ) {
    return ['en'];
  }

  return undefined;
}
