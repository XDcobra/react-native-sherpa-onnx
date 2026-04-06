import {
  exists,
  mkdir,
  readDir,
  readFile,
  stat,
  unlink,
} from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import { makeModelOperationKey } from './activeModelOperations';
import { listDownloadedModels, getModelPath } from './localModels';
import {
  getArchivePath,
  getExtractionStatePath,
  getModelDir,
  getModelsBaseDir,
  getNativeAssetExtractedModelDir,
  getReadyMarkerPath,
} from './paths';
import { runPostDownloadProcessing } from './postDownloadProcessing';
import { getModelById } from './registry';
import {
  type DownloadResult,
  type ExtractOptions,
  type ExtractionState,
  type ModelCategory,
  PauseError,
} from './types';
import { removeDirectoryRecursive, resolveActualModelDir } from './validation';

const EXTRACTION_STATE_PREFIX = '.extraction-state-';
const EXTRACTION_STATE_SUFFIX = '.json';

type ActiveExtractionOperation = {
  operationId: string;
  pauseRequested: boolean;
};

const activeExtractionOperations = new Map<string, ActiveExtractionOperation>();
const pendingExplicitPauseRequests = new Set<string>();

function makeExtractionOperationId(
  category: ModelCategory,
  id: string
): string {
  return `extract:${category}:${id}`;
}

export function consumePausedExtractionRequest(
  category: ModelCategory,
  id: string
): boolean {
  const key = makeModelOperationKey(category, id);
  const hasRequest = pendingExplicitPauseRequests.has(key);
  if (hasRequest) {
    pendingExplicitPauseRequests.delete(key);
  }
  return hasRequest;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError(): Error {
  const abortError = new Error('Extraction aborted');
  abortError.name = 'AbortError';
  return abortError;
}

async function cleanupCancelledExtraction(
  category: ModelCategory,
  id: string
): Promise<void> {
  const statePath = getExtractionStatePath(category, id);
  const modelDir = getModelDir(category, id);

  try {
    if (await exists(statePath)) {
      await unlink(statePath);
    }
  } catch {
    // ignore
  }

  try {
    if (await exists(modelDir)) {
      await unlink(modelDir);
    }
  } catch {
    // ignore
  }

  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
}

async function runExtraction(
  category: ModelCategory,
  id: string,
  opts?: ExtractOptions,
  resumeState?: ExtractionState
): Promise<DownloadResult> {
  const model = await getModelById(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  if (model.archiveExt !== 'tar.bz2') {
    throw new Error(
      `Model ${id} is not a tar.bz2 archive; extraction is only for archived models.`
    );
  }

  const downloadPath =
    resumeState?.archivePath ?? getArchivePath(category, id, model.archiveExt);
  const modelDir = resumeState?.modelDir ?? getModelDir(category, id);
  const statePath = getExtractionStatePath(category, id);

  if (!(await exists(downloadPath))) {
    throw new Error(
      `Archive not found at ${downloadPath}. Download the model first or ensure the archive is present.`
    );
  }

  const archiveStat = await stat(downloadPath);
  if (model.bytes > 0 && archiveStat.size < model.bytes) {
    throw new Error(
      `Archive is truncated (${archiveStat.size}/${model.bytes} bytes). Re-download or replace the file.`
    );
  }

  await mkdir(getModelsBaseDir(category));

  const key = makeModelOperationKey(category, id);
  pendingExplicitPauseRequests.delete(key);
  const activeOperation: ActiveExtractionOperation = {
    operationId: makeExtractionOperationId(category, id),
    pauseRequested: false,
  };
  activeExtractionOperations.set(key, activeOperation);

  const extractionSkipEntries =
    typeof resumeState?.lastEntryIndex === 'number'
      ? resumeState.lastEntryIndex + 1
      : 0;

  try {
    return await runPostDownloadProcessing({
      category,
      id,
      model,
      downloadPath,
      modelDir,
      isArchive: true,
      statePath,
      signal: opts?.signal,
      verifyChecksum: opts?.verifyChecksum,
      onChecksumMismatch: opts?.onChecksumMismatch,
      deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
      onProgress: opts?.onProgress,
      getDownloadedList: () => listDownloadedModels(category),
      extractionOperationId: activeOperation.operationId,
      extractionSkipEntries,
    });
  } catch (error) {
    if (activeOperation.pauseRequested) {
      consumePausedExtractionRequest(category, id);
      throw new PauseError(category, id, 'Extraction paused');
    }

    if (isAbortError(error) || opts?.signal?.aborted) {
      await cleanupCancelledExtraction(category, id);
      throw createAbortError();
    }

    throw error;
  } finally {
    activeExtractionOperations.delete(key);
  }
}

/**
 * Start extraction for a model. Archive must already exist.
 */
export async function extractModel(
  category: ModelCategory,
  id: string,
  opts?: ExtractOptions
): Promise<DownloadResult> {
  return runExtraction(category, id, opts);
}

export async function pauseExtraction(
  category: ModelCategory,
  id: string
): Promise<void> {
  const key = makeModelOperationKey(category, id);
  pendingExplicitPauseRequests.add(key);

  const operation = activeExtractionOperations.get(key);
  const operationId =
    operation?.operationId ?? makeExtractionOperationId(category, id);

  if (operation) {
    operation.pauseRequested = true;
  }

  try {
    await SherpaOnnx.cancelExtraction(operationId);
  } catch {
    // ignore pause races
  }
}

/**
 * Returns models with incomplete extractions in the given category.
 */
export async function getIncompleteExtractions(
  category: ModelCategory
): Promise<ExtractionState[]> {
  const baseDir = getModelsBaseDir(category);
  if (!(await exists(baseDir))) {
    return [];
  }

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
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
    if (await exists(readyPath)) {
      continue;
    }

    try {
      if (!(await exists(state.archivePath))) {
        continue;
      }

      const sourceStat = await stat(state.archivePath);
      if (state.model.bytes > 0 && sourceStat.size < state.model.bytes) {
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
 * Resume an incomplete extraction.
 */
export async function resumeExtraction(
  category: ModelCategory,
  id: string,
  opts?: ExtractOptions
): Promise<DownloadResult> {
  const statePath = getExtractionStatePath(category, id);
  if (!(await exists(statePath))) {
    return extractModel(category, id, opts);
  }

  let state: ExtractionState;
  try {
    const raw = await readFile(statePath, 'utf8');
    state = JSON.parse(raw) as ExtractionState;
  } catch {
    return extractModel(category, id, opts);
  }

  if (state.modelId !== id || state.category !== category) {
    return extractModel(category, id, opts);
  }

  const readyPath = getReadyMarkerPath(category, id);
  if (await exists(readyPath)) {
    try {
      await unlink(statePath);
    } catch {
      // non-fatal
    }

    const localPath =
      (await getModelPath(category, id)) ??
      (await resolveActualModelDir(state.modelDir));

    return {
      modelId: id,
      localPath,
    };
  }

  return runExtraction(category, id, opts, state);
}

/**
 * Remove extraction state and partial extraction output.
 */
export async function deleteIncompleteExtraction(
  category: ModelCategory,
  id: string
): Promise<void> {
  const statePath = getExtractionStatePath(category, id);
  if (await exists(statePath)) {
    await unlink(statePath);
  }

  const modelDir = getModelDir(category, id);
  if (await exists(modelDir)) {
    await unlink(modelDir);
  }

  await removeDirectoryRecursive(getNativeAssetExtractedModelDir(id));
}
