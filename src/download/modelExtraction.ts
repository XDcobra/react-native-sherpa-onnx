import {
  exists,
  readFile,
  readDir,
  mkdir,
  stat,
  unlink,
} from '@dr.pogodin/react-native-fs';
import type {
  ModelCategory,
  ModelMetaBase,
  ChecksumIssue,
  DownloadProgress,
  ExtractionState,
} from './types';
import type { DownloadResult } from './types';
import {
  getModelsBaseDir,
  getModelDir,
  getArchivePath,
  getReadyMarkerPath,
  getExtractionStatePath,
  getNativeAssetExtractedModelDir,
} from './paths';
import { runPostDownloadProcessing } from './postDownloadProcessing';
import { getModelByIdByCategory } from './registry';
import {
  listDownloadedModelsByCategory,
  getLocalModelPathByCategory,
} from './localModels';
import { resolveActualModelDir, removeDirectoryRecursive } from './validation';

const EXTRACTION_STATE_PREFIX = '.extraction-state-';
const EXTRACTION_STATE_SUFFIX = '.json';

/**
 * Start extraction for a model: archive must already exist (e.g. after download or from PAD).
 * Writes extraction state so that if the app crashes, extraction can be resumed via
 * getIncompleteExtractions + resumeExtraction.
 * Use signal to abort (pause) extraction.
 */
export async function extractModelByCategory<T extends ModelMetaBase>(
  category: ModelCategory,
  id: string,
  opts?: {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
    onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>;
    deleteArchiveAfterExtract?: boolean;
  }
): Promise<DownloadResult> {
  const model = await getModelByIdByCategory<T>(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }
  if (model.archiveExt !== 'tar.bz2') {
    throw new Error(
      `Model ${id} is not a tar.bz2 archive; extraction is only for archived models.`
    );
  }

  const downloadPath = getArchivePath(category, id, model.archiveExt);
  const modelDir = getModelDir(category, id);
  const statePath = getExtractionStatePath(category, id);

  const archiveExists = await exists(downloadPath);
  if (!archiveExists) {
    throw new Error(
      `Archive not found at ${downloadPath}. Download the model first or ensure the archive is present.`
    );
  }
  try {
    const archiveStat = await stat(downloadPath);
    if (model.bytes > 0 && archiveStat.size < model.bytes) {
      throw new Error(
        `Archive is truncated (${archiveStat.size}/${model.bytes} bytes). Re-download or replace the file.`
      );
    }
  } catch (statErr) {
    if (statErr instanceof Error) throw statErr;
    throw new Error('Failed to read archive size.');
  }

  await mkdir(getModelsBaseDir(category));

  return runPostDownloadProcessing({
    category,
    id,
    model,
    downloadPath,
    modelDir,
    isArchive: true,
    statePath,
    signal: opts?.signal,
    onChecksumIssue: opts?.onChecksumIssue,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
    onProgress: opts?.onProgress,
    getDownloadedList: () =>
      listDownloadedModelsByCategory<ModelMetaBase>(category),
  });
}

/**
 * Returns models in the given category that have incomplete extractions (e.g. after app
 * crash during extraction). Use with resumeExtraction to continue.
 */
export async function getIncompleteExtractions(
  category: ModelCategory
): Promise<ExtractionState[]> {
  const baseDir = getModelsBaseDir(category);
  const baseExists = await exists(baseDir);
  if (!baseExists) return [];

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readDir(baseDir);
  } catch {
    return [];
  }

  const results: ExtractionState[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (
      !name.startsWith(EXTRACTION_STATE_PREFIX) ||
      !name.endsWith(EXTRACTION_STATE_SUFFIX)
    ) {
      continue;
    }
    const modelId = name.slice(
      EXTRACTION_STATE_PREFIX.length,
      name.length - EXTRACTION_STATE_SUFFIX.length
    );
    const statePath = getExtractionStatePath(category, modelId);
    let state: ExtractionState;
    try {
      const raw = await readFile(statePath, 'utf8');
      state = JSON.parse(raw) as ExtractionState;
    } catch {
      continue;
    }
    const readyPath = getReadyMarkerPath(category, modelId);
    if (await exists(readyPath)) continue;
    try {
      const archiveExists = await exists(state.archivePath);
      if (!archiveExists) continue;
      const st = await stat(state.archivePath);
      if (
        state.model.bytes > 0 &&
        st.size != null &&
        st.size < state.model.bytes
      ) {
        continue;
      }
    } catch {
      continue;
    }
    results.push(state);
  }
  return results;
}

/**
 * Resume an incomplete extraction (e.g. after app restart). Use getIncompleteExtractions
 * to discover items to resume. Runs extraction from the start (archive is overwritten into
 * model dir with force).
 */
export async function resumeExtraction<T extends ModelMetaBase>(
  category: ModelCategory,
  id: string,
  opts?: {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
    onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>;
    deleteArchiveAfterExtract?: boolean;
  }
): Promise<DownloadResult> {
  const statePath = getExtractionStatePath(category, id);
  const stateExists = await exists(statePath);
  if (!stateExists) {
    return extractModelByCategory<T>(category, id, opts);
  }
  let state: ExtractionState;
  try {
    const raw = await readFile(statePath, 'utf8');
    state = JSON.parse(raw) as ExtractionState;
  } catch {
    return extractModelByCategory<T>(category, id, opts);
  }
  if (state.modelId !== id || state.category !== category) {
    return extractModelByCategory<T>(category, id, opts);
  }
  const readyPath = getReadyMarkerPath(category, id);
  if (await exists(readyPath)) {
    try {
      await unlink(statePath);
    } catch {
      // non-fatal
    }
    const localPath =
      (await getLocalModelPathByCategory(category, id)) ??
      (await resolveActualModelDir(state.modelDir));
    return { modelId: id, localPath };
  }

  return runPostDownloadProcessing({
    category: state.category,
    id: state.modelId,
    model: state.model,
    downloadPath: state.archivePath,
    modelDir: state.modelDir,
    isArchive: true,
    statePath,
    signal: opts?.signal,
    onChecksumIssue: opts?.onChecksumIssue,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
    onProgress: opts?.onProgress,
    getDownloadedList: () =>
      listDownloadedModelsByCategory<ModelMetaBase>(category),
  });
}

/**
 * Cancel/delete an incomplete extraction: removes extraction state and partial model dir.
 * Does not delete the archive so the user can retry extraction later.
 */
export async function deleteIncompleteExtraction(
  category: ModelCategory,
  id: string
): Promise<void> {
  const statePath = getExtractionStatePath(category, id);
  try {
    if (await exists(statePath)) await unlink(statePath);
  } catch {
    // non-fatal
  }
  const modelDir = getModelDir(category, id);
  try {
    if (await exists(modelDir)) await unlink(modelDir);
  } catch {
    // non-fatal
  }
  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
}
