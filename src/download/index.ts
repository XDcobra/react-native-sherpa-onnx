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

export {
  buildCatalogHintsMap,
  catalogDetectHintMatchesCategory,
  categoryUsesCatalogDetect,
  type CatalogDetectCategory,
  type CatalogDetectHint,
} from './catalogHints';

export {
  getAssetExtension,
  isAssetSupportedForCategory,
  stripAssetExtension,
} from './sources/github-asset-rules';

export {
  buildSourceModelsFromGithubReleaseAssets,
  deriveDisplayName,
  type GitHubReleaseAsset,
} from './sources/github-common';

export {
  filterHfRepoNamesForCategory,
  isHfRepoNameSupportedForCategory,
} from './sources/hf-author-filter';

export {
  buildFolderAssetsFromHfSiblings,
  buildSourceModelsFromHfAuthorRepoNames,
  hfRepoResolveUrl,
  isIncludedHfModelPath,
  type BuildHfAuthorSourceModelsOptions,
  type HfSiblingLike,
} from './sources/hf-author-common';

export { getProtectedKeys } from './protectedModelKeys';

export { purgeAll, type PurgeAllResult } from './bulkPurge';

export { checkDiskSpace } from './validation';

export type { BackgroundDownloaderSetConfigOptions } from './background-downloader-types';

export {
  BUILTIN_SOURCE_IDS,
  DOWNLOAD_ERROR_CODES,
  DownloadError,
  buildSourceFetchContext,
  configureSource,
  configureHuggingFaceSource,
  ensureBuiltinSourcesRegistered,
  getDefaultSourceForCategory,
  getHuggingFaceSourceConfig,
  getSource,
  getSourceConfig,
  huggingfaceProvider,
  listBuiltinSources,
  listSources,
  type DownloadErrorCode,
  type DownloadErrorMetadata,
  type BuiltinSourceId,
  SUPPORTED_ARCHIVE_FORMATS,
  type RequestPolicy,
  type SourceConfig,
  type SourceArchiveFormat,
  type SourceAssetEntry,
  type SourceAssetLayout,
  type SourceFetchContext,
  type HuggingFaceRepoSpec,
  type HuggingFaceSourceConfig,
  type SourceFetchOptions,
  type SourceFetchResult,
  type SourceModel,
  type SourceProvider,
  isArchiveLayout,
  isDownloadError,
  isDownloadErrorCode,
  isFolderLayout,
  isPauseCompatibleError,
  isSupportedArchiveFormat,
  registerSource,
  setDefaultSourceForCategory,
  sourceFetch,
  assertSupportedLayout,
  assertValidLayoutAssets,
  tryGetSource,
  unregisterSource,
} from './sources';
