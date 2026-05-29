import {
  DocumentDirectoryPath,
  exists,
  readDir,
  readFile,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { emitModelsListUpdated } from './downloadEvents';
import {
  getCachePath,
  getCacheDir,
  getDownloadStatePath,
  getExtractionStatePath,
  getManifestPath,
  getModelDir,
  getModelsBaseDir,
  getNativeAssetExtractedModelDir,
  getReadyMarkerPath,
  getSourceModelsBaseDir,
} from './paths';
import { clearMemoryCacheForCategory } from './registry';
import {
  ModelCategory,
  type ModelManifest,
  type ModelMeta,
  type ModelWithMetadata,
  type SourceSelectorOptions,
} from './types';
import { removeDirectoryRecursive, resolveActualModelDir } from './validation';

function resolveSourceId(source?: string | 'default'): string {
  if (!source || source === 'default') {
    return 'default';
  }

  return source;
}

async function listSourceDirs(category: ModelCategory): Promise<string[]> {
  const sourcesRoot = `${getModelsBaseDir(category)}/sources`;
  if (!(await exists(sourcesRoot))) {
    return [];
  }

  const entries = await readDir(sourcesRoot);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.path);
}

async function listDownloadedModelsAtBase(
  baseDir: string
): Promise<ModelMeta[]> {
  if (!(await exists(baseDir))) {
    return [];
  }

  const entries = await readDir(baseDir);
  const models: ModelMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = `${entry.path}/manifest.json`;
    if (!(await exists(manifestPath))) {
      continue;
    }

    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as ModelManifest;
      if (manifest.model) {
        const sourceId = resolveSourceId(manifest.model.sourceId);
        models.push({
          ...manifest.model,
          sourceId,
        });
      }
    } catch {
      // ignore invalid manifest
    }
  }

  return models;
}

export async function listDownloadedModels(
  category: ModelCategory,
  options?: SourceSelectorOptions
): Promise<ModelMeta[]> {
  const sourceId = options?.source;

  if (sourceId) {
    return listDownloadedModelsAtBase(
      getSourceModelsBaseDir(category, resolveSourceId(sourceId))
    );
  }

  const models: ModelMeta[] = [];
  const sourceDirs = await listSourceDirs(category);
  for (const sourceDir of sourceDirs) {
    const group = await listDownloadedModelsAtBase(sourceDir);
    models.push(...group);
  }

  return models;
}

export async function isModelDownloaded(
  category: ModelCategory,
  id: string,
  options?: SourceSelectorOptions
): Promise<boolean> {
  return exists(
    getReadyMarkerPath(category, id, resolveSourceId(options?.source))
  );
}

export async function getModelPath(
  category: ModelCategory,
  id: string,
  options?: SourceSelectorOptions
): Promise<string | null> {
  const sourceId = resolveSourceId(options?.source);
  const ready = await isModelDownloaded(category, id, { source: sourceId });
  if (!ready) {
    return null;
  }

  await updateModelLastUsed(category, id, { source: sourceId });
  return resolveActualModelDir(getModelDir(category, id, sourceId));
}

export async function updateModelLastUsed(
  category: ModelCategory,
  id: string,
  options?: SourceSelectorOptions
): Promise<void> {
  const sourceId = resolveSourceId(options?.source);
  const manifestPath = getManifestPath(category, id, sourceId);
  if (!(await exists(manifestPath))) {
    return;
  }

  try {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as ModelManifest;
    manifest.lastUsed = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  } catch (error) {
    console.warn(`Failed to update lastUsed for ${category}:${id}:`, error);
  }
}

export async function listDownloadedModelsWithMetadata(
  category: ModelCategory,
  options?: SourceSelectorOptions
): Promise<ModelWithMetadata[]> {
  const sourceId = resolveSourceId(options?.source);
  const baseDir = getSourceModelsBaseDir(category, sourceId);
  if (!(await exists(baseDir))) {
    return [];
  }

  const entries = await readDir(baseDir);
  const modelsWithMetadata: ModelWithMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = getManifestPath(category, entry.name, sourceId);
    if (!(await exists(manifestPath))) {
      continue;
    }

    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as ModelManifest;

      if (manifest.model) {
        modelsWithMetadata.push({
          model: manifest.model,
          downloadedAt: manifest.downloadedAt,
          lastUsed: manifest.lastUsed ?? null,
          sizeOnDisk: manifest.sizeOnDisk ?? entry.size,
          status: 'ready',
        });
      }
    } catch (error) {
      console.warn(
        `Failed to read manifest for ${category}:${entry.name}:`,
        error
      );
    }
  }

  return modelsWithMetadata;
}

export async function cleanupLeastRecentlyUsed(
  category: ModelCategory,
  options?: {
    targetBytes?: number;
    maxModelsToDelete?: number;
    keepCount?: number;
    source?: string | 'default';
  }
): Promise<string[]> {
  const sourceId = resolveSourceId(options?.source);
  const modelsWithMetadata = await listDownloadedModelsWithMetadata(category, {
    source: sourceId,
  });
  if (modelsWithMetadata.length === 0) {
    return [];
  }

  const keepCount = options?.keepCount ?? 1;
  if (modelsWithMetadata.length <= keepCount) {
    return [];
  }

  const sorted = modelsWithMetadata.sort((a, b) => {
    const aTime = a.lastUsed ?? a.downloadedAt;
    const bTime = b.lastUsed ?? b.downloadedAt;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  const deletedIds: string[] = [];
  let bytesFreed = 0;
  const targetBytes = options?.targetBytes ?? 0;
  const maxToDelete = options?.maxModelsToDelete ?? sorted.length - keepCount;

  for (let i = 0; i < sorted.length - keepCount && i < maxToDelete; i += 1) {
    const item = sorted[i];
    if (!item) {
      continue;
    }

    try {
      await deleteModel(category, item.model.id, sourceId);
      deletedIds.push(item.model.id);
      bytesFreed += item.sizeOnDisk ?? 0;

      if (targetBytes > 0 && bytesFreed >= targetBytes) {
        break;
      }
    } catch (error) {
      console.warn(
        `[LRU Cleanup] Failed to delete ${category}:${item.model.id}:`,
        error
      );
    }
  }

  return deletedIds;
}

export async function deleteModel(
  category: ModelCategory,
  id: string,
  source = 'default'
): Promise<void> {
  const sourceId = resolveSourceId(source);
  const modelDir = getModelDir(category, id, sourceId);
  const legacyArchivePath = `${getSourceModelsBaseDir(
    category,
    sourceId
  )}/${id}.tar.bz2`;
  const legacyOnnxPath = `${modelDir}/${id}.onnx`;
  const downloadStatePath = getDownloadStatePath(category, id, sourceId);
  const extractionStatePath = getExtractionStatePath(category, id, sourceId);

  if (await exists(modelDir)) {
    await unlink(modelDir);
  }
  if (await exists(legacyArchivePath)) {
    await unlink(legacyArchivePath);
  }
  if (await exists(legacyOnnxPath)) {
    await unlink(legacyOnnxPath);
  }
  if (await exists(downloadStatePath)) {
    await unlink(downloadStatePath);
  }
  if (await exists(extractionStatePath)) {
    await unlink(extractionStatePath);
  }

  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));

  const list = await listDownloadedModels(category, { source: sourceId });
  emitModelsListUpdated(category, list);
}

export async function clearModelsCache(
  category: ModelCategory,
  options?: SourceSelectorOptions
): Promise<void> {
  const sourceId = options?.source;

  if (sourceId) {
    const cachePath = getCachePath(category, resolveSourceId(sourceId));
    if (await exists(cachePath)) {
      await unlink(cachePath);
    }
  } else {
    const cacheDir = getCacheDir();
    if (await exists(cacheDir)) {
      const entries = await readDir(cacheDir);
      const baseName = getCachePath(category).split('/').pop() ?? '';
      const prefix = baseName.replace(/\.json$/i, '');

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        if (
          entry.name === `${prefix}.json` ||
          entry.name.startsWith(`${prefix}--`)
        ) {
          await unlink(entry.path);
        }
      }
    }
  }

  clearMemoryCacheForCategory(category);
}

export async function getStorageBasePath(): Promise<string> {
  return DocumentDirectoryPath;
}
