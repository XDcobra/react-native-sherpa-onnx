/**
 * Optional alignment-side language hints when native folder/catalog heuristics return no tags.
 * Currently no alignment models have specific language lists; returns undefined for all types.
 */
export function iso6391HintsForAlignmentModelType(
  _modelType: string | undefined
): string[] | undefined {
  return undefined;
}
