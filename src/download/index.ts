export {
  ModelCategory,
  PauseError,
  isPauseError,
  type CacheStatus,
  type ChecksumMismatchInfo,
  type ChecksumMismatchReason,
  type DownloadOptions,
  type DownloadProgressListener,
  type DownloadResult,
  type DownloadState,
  type EnsureModelOptions,
  type EnsureModelResult,
  type ExtractOptions,
  type ExtractionState,
  type ModelMeta,
  type ModelWithMetadata,
  type ModelsListUpdatedListener,
  type Progress,
  type ProgressPhase,
  isActiveExtractionPhase,
  type Quantization,
  type SizeTier,
  type TtsModelType,
} from './types';

export {
  subscribeDownloadProgress as onProgress,
  subscribeModelsListUpdated as onModelsListUpdated,
} from './downloadEvents';

export {
  listModels,
  refreshModels,
  getModelsCacheStatus,
  getModelById,
  type RefreshModelsOptions,
} from './registry';

export {
  listDownloadedModels,
  isModelDownloaded,
  getModelPath,
  updateModelLastUsed,
  listDownloadedModelsWithMetadata,
  cleanupLeastRecentlyUsed,
  deleteModel,
  clearModelsCache,
  getStorageBasePath,
} from './localModels';

export {
  configureBackgroundDownloader,
  downloadModel,
  pauseDownload,
  resumeDownload,
  getIncompleteDownloads,
  deleteIncompleteDownload,
} from './downloadTask';

export {
  extractModel,
  pauseExtraction,
  resumeExtraction,
  getIncompleteExtractions,
  deleteIncompleteExtraction,
} from './modelExtraction';

export { ensureModel } from './ensureModel';

export { getProtectedKeys } from './protectedModelKeys';

export { purgeAll, type PurgeAllResult } from './bulkPurge';

export { checkDiskSpace } from './validation';

export type { BackgroundDownloaderSetConfigOptions } from './background-downloader-types';

export { DEFAULT_TTS_CATALOG_HINTS_CHUNK_SIZE } from './constants';
