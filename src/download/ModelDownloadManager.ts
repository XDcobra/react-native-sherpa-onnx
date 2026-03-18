// Re-export types and enum for public API
export {
  ModelCategory,
  type TtsModelType,
  type Quantization,
  type SizeTier,
  type ModelMetaBase,
  type TtsModelMeta,
  type DownloadProgress,
  type DownloadResult,
  type DownloadState,
  type ExtractionState,
  type DownloadProgressListener,
  type ModelsListUpdatedListener,
  type ModelWithMetadata,
} from './types';
export {
  subscribeDownloadProgress,
  subscribeModelsListUpdated,
} from './downloadEvents';
export {
  listModelsByCategory,
  refreshModelsByCategory,
  getModelsCacheStatusByCategory,
  getModelByIdByCategory,
} from './registry';
export {
  listDownloadedModelsByCategory,
  isModelDownloadedByCategory,
  getLocalModelPathByCategory,
  updateModelLastUsed,
  listDownloadedModelsWithMetadata,
  cleanupLeastRecentlyUsed,
  deleteModelByCategory,
  clearModelCacheByCategory,
  getDownloadStorageBase,
} from './localModels';
export {
  downloadModelByCategory,
  getIncompleteDownloads,
  resumeDownload,
  deleteIncompleteDownload,
} from './downloadTask';
export {
  extractModelByCategory,
  getIncompleteExtractions,
  resumeExtraction,
  deleteIncompleteExtraction,
} from './modelExtraction';
export { ensureModelByCategory } from './ensureModel';
export type { EnsureModelOptions } from './ensureModel';
