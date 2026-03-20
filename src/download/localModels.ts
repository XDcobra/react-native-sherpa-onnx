import { Platform } from 'react-native';
import {
  DocumentDirectoryPath,
  exists,
  readFile,
  readDir,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import type {
  ModelCategory,
  ModelMetaBase,
  ModelManifest,
  ModelWithMetadata,
} from './types';
import {
  getCachePath,
  getModelsBaseDir,
  getModelDir,
  getManifestPath,
  getReadyMarkerPath,
  getTarArchivePath,
  getOnnxPath,
} from './paths';
import { resolveActualModelDir } from './validation';
import { emitModelsListUpdated } from './downloadEvents';
import { clearMemoryCacheForCategory } from './registry';

export async function listDownloadedModelsByCategory<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<T[]> {
  const baseDir = getModelsBaseDir(category);
  const existsResult = await exists(baseDir);
  if (!existsResult) return [];

  const entries = await readDir(baseDir);
  const models: T[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = getManifestPath(category, entry.name);
    const manifestExists = await exists(manifestPath);
    if (!manifestExists) continue;
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as ModelManifest<T>;
      if (manifest.model) {
        models.push(manifest.model);
      }
    } catch {
      // ignore invalid manifest
    }
  }

  return models;
}

export async function isModelDownloadedByCategory(
  category: ModelCategory,
  id: string
): Promise<boolean> {
  const readyPath = getReadyMarkerPath(category, id);
  return exists(readyPath);
}

export async function getLocalModelPathByCategory(
  category: ModelCategory,
  id: string
): Promise<string | null> {
  const ready = await isModelDownloadedByCategory(category, id);
  if (!ready) return null;

  await updateModelLastUsed(category, id);

  const installDir = getModelDir(category, id);
  return resolveActualModelDir(installDir);
}

export async function updateModelLastUsed(
  category: ModelCategory,
  id: string
): Promise<void> {
  const manifestPath = getManifestPath(category, id);
  const existsResult = await exists(manifestPath);
  if (!existsResult) return;

  try {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as ModelManifest;
    manifest.lastUsed = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  } catch (error) {
    console.warn(`Failed to update lastUsed for ${category}:${id}:`, error);
  }
}

export async function listDownloadedModelsWithMetadata<T extends ModelMetaBase>(
  category: ModelCategory
): Promise<ModelWithMetadata<T>[]> {
  const baseDir = getModelsBaseDir(category);
  const existsResult = await exists(baseDir);
  if (!existsResult) return [];

  const entries = await readDir(baseDir);
  const modelsWithMetadata: ModelWithMetadata<T>[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = getManifestPath(category, entry.name);
    const manifestExists = await exists(manifestPath);

    if (manifestExists) {
      try {
        const raw = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as ModelManifest<T>;
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

  for (let i = 0; i < sorted.length - keepCount && i < maxToDelete; i++) {
    const item = sorted[i];
    if (!item) continue;

    try {
      await deleteModelByCategory(category, item.model.id);
      deletedIds.push(item.model.id);
      bytesFreed += item.sizeOnDisk ?? 0;

      console.log(
        `[LRU Cleanup] Deleted ${category}:${item.model.id} (freed ${
          (item.sizeOnDisk ?? 0) / 1024 / 1024
        } MB)`
      );

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

export async function deleteModelByCategory(
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
  const list = await listDownloadedModelsByCategory<ModelMetaBase>(category);
  emitModelsListUpdated(category, list);
}

export async function clearModelCacheByCategory(
  category: ModelCategory
): Promise<void> {
  const cachePath = getCachePath(category);
  if (await exists(cachePath)) {
    await unlink(cachePath);
  }
  clearMemoryCacheForCategory(category);
}

export async function getDownloadStorageBase(): Promise<string> {
  if (Platform.OS === 'ios') {
    return DocumentDirectoryPath;
  }
  return DocumentDirectoryPath;
}
