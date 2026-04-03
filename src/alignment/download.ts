import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  ModelCategory,
  ensureModelByCategory,
  getLocalModelPathByCategory,
  isModelDownloadedByCategory,
  deleteModelByCategory,
  refreshModelsByCategory,
} from '../download';
import type { ModelMetaBase } from '../download';
import type { DownloadAlignmentModelOptions } from './types';

export const DEFAULT_ALIGNMENT_MODEL_ID = 'wav2vec2-base-960h-int8';
/** @deprecated Use DEFAULT_ALIGNMENT_MODEL_ID. */
export const DEFAULT_ALIGNMENT_MODEL_URL = DEFAULT_ALIGNMENT_MODEL_ID;
const ALIGNMENT_MODEL_FILENAME = 'model.onnx';

async function findModelFilePath(
  rootDir: string,
  maxDepth = 4
): Promise<string | null> {
  const directPath = `${rootDir}/${ALIGNMENT_MODEL_FILENAME}`.replace(
    /\/+/g,
    '/'
  );
  if (await exists(directPath)) {
    return directPath;
  }

  if (maxDepth <= 0) {
    return null;
  }

  try {
    const entries = await readDir(rootDir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = (entry.path ?? `${rootDir}/${entry.name}`).replace(
        /\/+/g,
        '/'
      );
      const foundPath = await findModelFilePath(entryPath, maxDepth - 1);
      if (foundPath) {
        return foundPath;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function downloadAlignmentModel(
  options?: DownloadAlignmentModelOptions
): Promise<string> {
  const modelId = options?.modelId?.trim() || DEFAULT_ALIGNMENT_MODEL_ID;

  if (options?.url?.trim()) {
    console.warn(
      '[SherpaOnnxAlignment] DownloadAlignmentModelOptions.url is deprecated and ignored. Use modelId from ModelCategory.Subtitles.'
    );
  }

  await refreshModelsByCategory<ModelMetaBase>(ModelCategory.Subtitles, {
    forceRefresh: false,
  });

  await ensureModelByCategory<ModelMetaBase>(ModelCategory.Subtitles, modelId, {
    signal: options?.signal,
    onProgress: (progress) => {
      options?.onProgress?.({
        bytesWritten: progress.bytesDownloaded,
        contentLength: progress.totalBytes ?? 0,
      });
    },
  });

  const modelPath = await getAlignmentModelPath(modelId);
  if (!modelPath) {
    throw new Error(
      `Failed to resolve ${ALIGNMENT_MODEL_FILENAME} for alignment model: ${modelId}`
    );
  }
  return modelPath;
}

export async function isAlignmentModelReady(
  modelId = DEFAULT_ALIGNMENT_MODEL_ID
): Promise<boolean> {
  return isModelDownloadedByCategory(ModelCategory.Subtitles, modelId);
}

export async function getAlignmentModelPath(
  modelId = DEFAULT_ALIGNMENT_MODEL_ID
): Promise<string | null> {
  const modelDir = await getLocalModelPathByCategory(
    ModelCategory.Subtitles,
    modelId
  );
  if (!modelDir) {
    return null;
  }
  return findModelFilePath(modelDir);
}

export async function deleteAlignmentModel(
  modelId = DEFAULT_ALIGNMENT_MODEL_ID
): Promise<void> {
  await deleteModelByCategory(ModelCategory.Subtitles, modelId);
}
