import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { ModelCategory } from './types';
import type { SourceAssetEntry, SourceAssetLayout } from './sources/types';

type CategoryConfig = {
  tag: string;
  cacheFile: string;
  baseDir: string;
};

export const DEFAULT_SOURCE_ID = 'default';

export const CATEGORY_CONFIG: Record<ModelCategory, CategoryConfig> = {
  [ModelCategory.Tts]: {
    tag: 'tts-models',
    cacheFile: 'tts-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/tts`,
  },
  [ModelCategory.Stt]: {
    tag: 'asr-models',
    cacheFile: 'asr-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/stt`,
  },
  [ModelCategory.Vad]: {
    tag: 'asr-models',
    cacheFile: 'vad-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/vad`,
  },
  [ModelCategory.Punctuation]: {
    tag: 'punctuation-models',
    cacheFile: 'punctuation-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/punctuation`,
  },
  [ModelCategory.Diarization]: {
    tag: 'speaker-segmentation-models',
    cacheFile: 'diarization-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/diarization`,
  },
  [ModelCategory.Enhancement]: {
    tag: 'speech-enhancement-models',
    cacheFile: 'enhancement-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/enhancement`,
  },
  [ModelCategory.Separation]: {
    tag: 'source-separation-models',
    cacheFile: 'separation-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/separation`,
  },
  [ModelCategory.Qnn]: {
    tag: 'asr-models-qnn-binary',
    cacheFile: 'qnn-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/qnn`,
  },
  [ModelCategory.Alignment]: {
    tag: 'alignment-models',
    cacheFile: 'alignment-models.json',
    baseDir: `${DocumentDirectoryPath}/sherpa-onnx/models/alignment`,
  },
};

export function getCategoryTag(category: ModelCategory): string {
  return CATEGORY_CONFIG[category].tag;
}

export function getCacheDir(): string {
  return `${DocumentDirectoryPath}/sherpa-onnx/cache`;
}

export function sanitizeSourceId(sourceId: string): string {
  return sourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveSourceId(sourceId?: string): string {
  if (!sourceId || sourceId === DEFAULT_SOURCE_ID) {
    return DEFAULT_SOURCE_ID;
  }
  return sourceId;
}

export function getCachePath(
  category: ModelCategory,
  sourceId = DEFAULT_SOURCE_ID
): string {
  const cacheFile = CATEGORY_CONFIG[category].cacheFile;

  if (sourceId === DEFAULT_SOURCE_ID) {
    return `${getCacheDir()}/${cacheFile}`;
  }

  const baseName = cacheFile.replace(/\.json$/i, '');
  return `${getCacheDir()}/${baseName}--${sanitizeSourceId(sourceId)}.json`;
}

export function getModelsBaseDir(category: ModelCategory): string {
  return CATEGORY_CONFIG[category].baseDir;
}

export function getSourceModelsBaseDir(
  category: ModelCategory,
  sourceId?: string
): string {
  const sourceSegment = sanitizeSourceId(resolveSourceId(sourceId));
  return `${getModelsBaseDir(category)}/sources/${sourceSegment}`;
}

export function getModelDir(
  category: ModelCategory,
  modelId: string,
  sourceId?: string
): string {
  return `${getSourceModelsBaseDir(category, sourceId)}/${modelId}`;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function getPrimaryAssetFilename(
  modelId: string,
  layout: SourceAssetLayout,
  assets: ReadonlyArray<SourceAssetEntry>
): string {
  const asset = assets[0];
  if (asset?.relativePath) {
    const normalized = normalizeRelativePath(asset.relativePath);
    const filename = normalized.split('/').pop();
    if (filename && filename.length > 0) {
      return filename;
    }
  }

  if (layout.kind === 'archive') {
    return `${modelId}.${layout.format}`;
  }

  return `${modelId}.onnx`;
}

export function getAssetDestPath(
  category: ModelCategory,
  modelId: string,
  relativePath: string,
  sourceId?: string
): string {
  const normalized = normalizeRelativePath(relativePath);
  return `${getModelDir(category, modelId, sourceId)}/${normalized}`;
}

export function getArchivePath(
  category: ModelCategory,
  modelId: string,
  layout: SourceAssetLayout,
  assets: ReadonlyArray<SourceAssetEntry>,
  sourceId?: string
): string {
  const primaryAssetFilename = getPrimaryAssetFilename(modelId, layout, assets);
  if (layout.kind === 'archive') {
    return `${getSourceModelsBaseDir(
      category,
      sourceId
    )}/${primaryAssetFilename}`;
  }

  return getAssetDestPath(category, modelId, primaryAssetFilename, sourceId);
}

export function getReadyMarkerPath(
  category: ModelCategory,
  modelId: string,
  sourceId?: string
): string {
  return `${getModelDir(category, modelId, sourceId)}/.ready`;
}

export function getManifestPath(
  category: ModelCategory,
  modelId: string,
  sourceId?: string
): string {
  return `${getModelDir(category, modelId, sourceId)}/manifest.json`;
}

export function getDownloadStatePath(
  category: ModelCategory,
  modelId: string,
  sourceId?: string
): string {
  return `${getSourceModelsBaseDir(
    category,
    sourceId
  )}/.download-state-${modelId}.json`;
}

export function getTempModelDir(
  category: ModelCategory,
  modelId: string,
  tempToken: string,
  sourceId?: string
): string {
  return `${getSourceModelsBaseDir(
    category,
    sourceId
  )}/.tmp-${modelId}-${tempToken}`;
}

export function getExtractionStatePath(
  category: ModelCategory,
  modelId: string,
  sourceId?: string
): string {
  return `${getSourceModelsBaseDir(
    category,
    sourceId
  )}/.extraction-state-${modelId}.json`;
}

/**
 * Directory where native `resolveAssetPath` materializes a bundled model folder.
 */
export function getNativeAssetExtractedModelDir(modelId: string): string {
  const safeId = modelId.replace(/[/\\]/g, '');
  return `${DocumentDirectoryPath}/models/${safeId}`.replace(/\/+/g, '/');
}
