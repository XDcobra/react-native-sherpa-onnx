import { ModelCategory } from './types';

export const CATALOG_DETECT_CATEGORIES = new Set<ModelCategory>([
  ModelCategory.Tts,
  ModelCategory.Stt,
  ModelCategory.Qnn,
  ModelCategory.Vad,
  ModelCategory.Punctuation,
  ModelCategory.Enhancement,
  ModelCategory.Alignment,
]);

export type CatalogDetectCategory =
  | ModelCategory.Tts
  | ModelCategory.Stt
  | ModelCategory.Qnn
  | ModelCategory.Vad
  | ModelCategory.Punctuation
  | ModelCategory.Enhancement
  | ModelCategory.Alignment;

export function categoryUsesCatalogDetect(
  category: ModelCategory
): category is CatalogDetectCategory {
  return CATALOG_DETECT_CATEGORIES.has(category);
}
