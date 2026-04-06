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
  getManifestPath,
  getModelDir,
  getModelsBaseDir,
  getOnnxPath,
  getReadyMarkerPath,
  getTarArchivePath,
} from './paths';
import { clearMemoryCacheForCategory } from './registry';
import {
  type ModelCategory,
  type ModelManifest,
  type ModelMeta,
  type ModelWithMetadata,
} from './types';
import { resolveActualModelDir } from './validation';

export async function listDownloadedModels(
  category: ModelCategory
): Promise<ModelMeta[]> {
  const baseDir = getModelsBaseDir(category);
  if (!(await exists(baseDir))) {
    return [];
  }

  const entries = await readDir(baseDir);
  const models: ModelMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = getManifestPath(category, entry.name);
    if (!(await exists(manifestPath))) {
      continue;
    }

    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as ModelManifest;
      if (manifest.model) {
        models.push(manifest.model);
      }
    } catch {
      // ignore invalid manifest
    }
  }

  return models;
}

export async function isModelDownloaded(
  category: ModelCategory,
  id: string
): Promise<boolean> {
  return exists(getReadyMarkerPath(category, id));
}

export async function getModelPath(
  category: ModelCategory,
  id: string
): Promise<string | null> {
  const ready = await isModelDownloaded(category, id);
  if (!ready) {
    return null;
  }

  await updateModelLastUsed(category, id);
  return resolveActualModelDir(getModelDir(category, id));
}

export async function updateModelLastUsed(
  category: ModelCategory,
  id: string
): Promise<void> {
  const manifestPath = getManifestPath(category, id);
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
  category: ModelCategory
): Promise<ModelWithMetadata[]> {
  const baseDir = getModelsBaseDir(category);
  if (!(await exists(baseDir))) {
    return [];
  }

  const entries = await readDir(baseDir);
  const modelsWithMetadata: ModelWithMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = getManifestPath(category, entry.name);
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
  }
): Promise<string[]> {
  const modelsWithMetadata = await listDownloadedModelsWithMetadata(category);
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
      await deleteModel(category, item.model.id);
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
  id: string
): Promise<void> {
  const modelDir = getModelDir(category, id);
  const tarPath = getTarArchivePath(category, id);
  const onnxPath = getOnnxPath(category, id);

  if (await exists(modelDir)) {
    await unlink(modelDir);
  }
  if (await exists(tarPath)) {
    await unlink(tarPath);
  }
  if (await exists(onnxPath)) {
    await unlink(onnxPath);
  }

  const list = await listDownloadedModels(category);
  emitModelsListUpdated(category, list);
}

export async function clearModelsCache(category: ModelCategory): Promise<void> {
  const cachePath = getCachePath(category);
  if (await exists(cachePath)) {
    await unlink(cachePath);
  }
  clearMemoryCacheForCategory(category);
}

export async function getStorageBasePath(): Promise<string> {
  return DocumentDirectoryPath;
}
