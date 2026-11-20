import {
  exists,
  moveFile,
  readFile,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import {
  makeDownloadTaskId,
  resolveDownloadHeaders,
  trackAssetDownloadTask,
  verifyDownloadedAssetChecksum,
} from './assetDownload';
import { emitDownloadProgress } from './downloadEvents';
import { createForegroundDownloadTask } from './foregroundDownload';
import { getManifestPath } from './paths';
import type { SourceAssetEntry } from './sources/types';
import type {
  DownloadOptions,
  ModelCategory,
  ModelManifest,
  ModelMeta,
  Progress,
} from './types';

/** Sum of the known supplement sizes of `model` (0 when it has none). */
export function getSupplementBytes(model: ModelMeta): number {
  return (model.supplements ?? []).reduce(
    (sum, supplement) => sum + (supplement.bytes ?? 0),
    0
  );
}

/**
 * Size of the archive (first asset). `model.bytes` also counts the supplements, so
 * archive size checks must use this instead.
 */
export function getArchiveBytes(model: ModelMeta): number {
  const primary = model.assets[0]?.bytes;
  if (typeof primary === 'number' && primary > 0) {
    return primary;
  }
  return Math.max(0, model.bytes - getSupplementBytes(model));
}

function supplementFileName(supplement: SourceAssetEntry): string {
  return (
    supplement.relativePath.replace(/\\/g, '/').split('/').pop() ??
    supplement.relativePath
  );
}

/** Supplements of `model` that are not in `modelDir` yet. */
export async function findMissingSupplements(
  model: ModelMeta,
  modelDir: string
): Promise<SourceAssetEntry[]> {
  const missing: SourceAssetEntry[] = [];
  for (const supplement of model.supplements ?? []) {
    if (!(await exists(`${modelDir}/${supplementFileName(supplement)}`))) {
      missing.push(supplement);
    }
  }
  return missing;
}

async function removeIfExists(path: string): Promise<void> {
  try {
    if (await exists(path)) {
      await unlink(path);
    }
  } catch {
    // ignore
  }
}

export type DownloadSupplementsOptions = Pick<
  DownloadOptions,
  'signal' | 'verifyChecksum' | 'onChecksumMismatch' | 'onProgress'
> & {
  category: ModelCategory;
  model: ModelMeta;
  sourceId: string;
  /** Directory the engine reads (the resolved model directory). */
  targetDir: string;
  /** Files to fetch; default: every supplement of `model`. */
  supplements?: SourceAssetEntry[];
  /** Bytes and assets already downloaded in this run, so progress continues from them. */
  precedingBytes?: number;
  precedingAssetCount?: number;
};

/**
 * Downloads supplement files into `targetDir`, one after the other. A file that is
 * already there is kept (the pack may ship it). Each file goes to a `.part` path first
 * and is moved into place only after its checksum passed, so the engine never sees a
 * partial file. Throws an `AbortError` when `signal` aborts.
 *
 * @returns Bytes written.
 */
export async function downloadSupplements(
  options: DownloadSupplementsOptions
): Promise<number> {
  const { category, model, sourceId, targetDir } = options;
  const supplements = options.supplements ?? model.supplements ?? [];
  if (supplements.length === 0) {
    return 0;
  }

  const precedingBytes = options.precedingBytes ?? 0;
  const precedingAssetCount = options.precedingAssetCount ?? 0;
  const supplementTotal = supplements.reduce(
    (sum, supplement) => sum + (supplement.bytes ?? 0),
    0
  );
  const totalBytes = precedingBytes + supplementTotal;
  const assetCount = precedingAssetCount + supplements.length;
  const headers = resolveDownloadHeaders(sourceId);
  const baseTaskId = makeDownloadTaskId(category, model.id, sourceId);

  let doneBytes = 0;
  let written = 0;

  for (let index = 0; index < supplements.length; index += 1) {
    const supplement = supplements[index]!;
    const fileName = supplementFileName(supplement);
    const destination = `${targetDir}/${fileName}`;
    if (await exists(destination)) {
      doneBytes += supplement.bytes ?? 0;
      continue;
    }

    const partPath = `${destination}.part`;
    await removeIfExists(partPath);

    const report = (bytesDownloaded: number) => {
      const processed = precedingBytes + doneBytes + bytesDownloaded;
      const total = Math.max(totalBytes, processed);
      const progress: Progress = {
        bytesProcessed: processed,
        totalBytes: total,
        percent: total > 0 ? (processed / total) * 100 : 0,
        phase: 'downloading',
        assetIndex: precedingAssetCount + index,
        assetCount,
      };
      options.onProgress?.(progress);
      emitDownloadProgress(category, model.id, progress);
    };

    try {
      const task = createForegroundDownloadTask({
        id: `${baseTaskId}:supplement:${fileName}`,
        url: supplement.url,
        destination: partPath,
        headers,
      });
      await trackAssetDownloadTask({
        category,
        id: model.id,
        sourceId,
        task,
        signal: options.signal,
        onProgress: report,
      });
      await verifyDownloadedAssetChecksum({
        category,
        modelId: model.id,
        sourceId,
        relativePath: fileName,
        filePath: partPath,
        expectedSha256: supplement.sha256,
        verifyChecksum: options.verifyChecksum,
        onChecksumMismatch: options.onChecksumMismatch,
      });
      await moveFile(partPath, destination);
    } catch (error) {
      await removeIfExists(partPath);
      throw error;
    }

    doneBytes += supplement.bytes ?? 0;
    written += supplement.bytes ?? 0;
    report(0);
  }

  return written;
}

/**
 * Downloads the supplements an already installed model lacks (a model downloaded before
 * its catalog entry listed them) and records the current catalog entry in its manifest.
 *
 * @returns Number of files fetched.
 */
export async function repairMissingSupplements(
  options: Omit<DownloadSupplementsOptions, 'supplements'>
): Promise<number> {
  const missing = await findMissingSupplements(
    options.model,
    options.targetDir
  );
  if (missing.length === 0) {
    return 0;
  }

  const written = await downloadSupplements({
    ...options,
    supplements: missing,
  });

  const manifestPath = getManifestPath(
    options.category,
    options.model.id,
    options.sourceId
  );
  try {
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as ModelManifest;
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        model: options.model,
        ...(typeof manifest.sizeOnDisk === 'number'
          ? { sizeOnDisk: manifest.sizeOnDisk + written }
          : {}),
      }),
      'utf8'
    );
  } catch {
    // The files are in place; a stale manifest only affects listings.
  }

  return missing.length;
}
