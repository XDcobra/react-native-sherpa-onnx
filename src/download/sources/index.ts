export {
  DOWNLOAD_ERROR_CODES,
  DownloadError,
  type DownloadErrorCode,
  type DownloadErrorMetadata,
  isDownloadError,
  isDownloadErrorCode,
  isPauseCompatibleError,
} from './errors';

export {
  buildSourceFetchContext,
  configureSource,
  ensureBuiltinSourcesRegistered,
  getDefaultSourceForCategory,
  getSource,
  getSourceConfig,
  listBuiltinSources,
  listSources,
  registerSource,
  setDefaultSourceForCategory,
  tryGetSource,
  unregisterSource,
  type SourceConfig,
} from './registry';

export {
  BUILTIN_SOURCE_IDS,
  configureHuggingFaceSource,
  getHuggingFaceSourceConfig,
  huggingfaceProvider,
  type BuiltinSourceId,
  type HuggingFaceRepoSpec,
  type HuggingFaceSourceConfig,
} from './builtin';

export {
  SUPPORTED_ARCHIVE_FORMATS,
  assertSupportedLayout,
  assertValidLayoutAssets,
  isSupportedArchiveFormat,
} from './formats';

export {
  sourceFetch,
  type SourceFetchOptions,
  type SourceFetchResult,
} from './fetch';

export {
  type RequestPolicy,
  type SourceArchiveFormat,
  type SourceAssetEntry,
  type SourceAssetLayout,
  type SourceFetchContext,
  type SourceModel,
  type SourceProvider,
  isArchiveLayout,
  isFolderLayout,
} from './types';
