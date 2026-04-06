import {
  DocumentDirectoryPath,
  exists,
  readDir,
  stat,
  unlink,
} from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';

export type ValidationError =
  | 'CHECKSUM_MISMATCH'
  | 'CHECKSUM_FAILED'
  | 'MISSING_FILES'
  | 'INSUFFICIENT_DISK_SPACE';

export class ValidationResult {
  success: boolean;
  error?: ValidationError;
  message?: string;

  constructor(success: boolean, error?: ValidationError, message?: string) {
    this.success = success;
    this.error = error;
    this.message = message;
  }
}

/**
 * Delete a directory and all contents. No-op if the path is missing.
 * Best-effort: continues on per-entry errors (permissions, race).
 */
export async function removeDirectoryRecursive(dirPath: string): Promise<void> {
  if (!(await exists(dirPath))) {
    return;
  }

  let entries:
    | Array<{ name: string; isDirectory: () => boolean; path?: string }>
    | undefined;

  try {
    entries = await readDir(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const childPath = `${dirPath}/${entry.name}`.replace(/\/+/g, '/');

    try {
      if (entry.isDirectory()) {
        await removeDirectoryRecursive(childPath);
      } else {
        await unlink(childPath);
      }
    } catch {
      // ignore per-entry failures
    }
  }

  try {
    await unlink(dirPath);
  } catch {
    // ignore
  }
}

export function parseChecksumFile(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  const lines = content.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    const [filename, hash] = line.split(/\s+/);
    if (filename && hash) {
      checksums.set(filename.trim(), hash.trim());
    }
  }

  return checksums;
}

export async function calculateFileChecksum(
  filePath: string,
  onProgress?: (
    bytesProcessed: number,
    totalBytes: number,
    percent: number
  ) => void
): Promise<string> {
  try {
    const digest = await SherpaOnnx.computeFileSha256(filePath);

    if (onProgress) {
      const statResult = await stat(filePath);
      const total = statResult.size;
      onProgress(total, total, 100);
    }

    return digest.toLowerCase();
  } catch (error) {
    throw new Error(`Failed to calculate checksum: ${String(error)}`);
  }
}

export async function validateChecksum(
  filePath: string,
  expectedChecksum: string,
  onProgress?: (
    bytesProcessed: number,
    totalBytes: number,
    percent: number
  ) => void
): Promise<ValidationResult> {
  try {
    const actualChecksum = await calculateFileChecksum(filePath, onProgress);

    if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
      return new ValidationResult(
        false,
        'CHECKSUM_MISMATCH',
        `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`
      );
    }

    return new ValidationResult(true);
  } catch (error) {
    return new ValidationResult(
      false,
      'CHECKSUM_FAILED',
      `Failed to validate checksum: ${String(error)}`
    );
  }
}

export async function validateExtractedFiles(
  modelDir: string,
  _category: string
): Promise<ValidationResult> {
  try {
    const dirExists = await exists(modelDir);
    if (!dirExists) {
      return new ValidationResult(
        false,
        'MISSING_FILES',
        `Model directory does not exist: ${modelDir}`
      );
    }

    const isModelLikeFile = (name: string): boolean => {
      const lower = name.toLowerCase();
      return (
        lower.endsWith('.onnx') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.bin') ||
        lower.endsWith('.json')
      );
    };

    const collectFilesRecursive = async (
      dir: string,
      depth = 0,
      maxDepth = 4
    ): Promise<
      Array<{ name: string; isDirectory: () => boolean; path?: string }>
    > => {
      if (depth > maxDepth) {
        return [];
      }

      const entries = await readDir(dir);
      const files: Array<{
        name: string;
        isDirectory: () => boolean;
        path?: string;
      }> = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.path != null) {
            const nested = await collectFilesRecursive(
              entry.path,
              depth + 1,
              maxDepth
            );
            files.push(...nested);
          }
        } else {
          files.push(entry);
        }
      }

      return files;
    };

    const entries = await readDir(modelDir);
    const actualFiles = entries.filter((entry) => !entry.isDirectory());
    const subdirs = entries.filter((entry) => entry.isDirectory());

    if (actualFiles.length === 0 && subdirs.length === 0) {
      return new ValidationResult(
        false,
        'MISSING_FILES',
        `Extraction failed: directory is empty: ${modelDir}`
      );
    }

    let hasModelLikeFiles = actualFiles.some((file) =>
      isModelLikeFile(file.name ?? '')
    );

    if (!hasModelLikeFiles) {
      const nestedFiles = await collectFilesRecursive(modelDir);
      hasModelLikeFiles = nestedFiles.some((file) =>
        isModelLikeFile(file.name ?? '')
      );
    }

    if (!hasModelLikeFiles) {
      return new ValidationResult(
        false,
        'MISSING_FILES',
        `Extraction may have failed: no model files (.onnx/.txt/.bin/.json) found under ${modelDir}`
      );
    }

    return new ValidationResult(true);
  } catch (error) {
    return new ValidationResult(
      false,
      'MISSING_FILES',
      `Failed to validate extracted files: ${String(error)}`
    );
  }
}

function isNativeModelFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.onnx') || lower.endsWith('.bin');
}

async function dirContainsModelFiles(dir: string): Promise<boolean> {
  const entries = await readDir(dir);
  const files = entries.filter((entry) => !entry.isDirectory());

  if (files.some((entry) => isNativeModelFileName(entry.name ?? ''))) {
    return true;
  }

  const subdirs = entries.filter((entry) => entry.isDirectory());
  for (const sub of subdirs) {
    const subPath = sub.path;
    if (subPath == null) {
      continue;
    }

    const subEntries = await readDir(subPath);
    const subFiles = subEntries.filter((entry) => !entry.isDirectory());
    if (subFiles.some((entry) => isNativeModelFileName(entry.name ?? ''))) {
      return true;
    }
  }

  return false;
}

export async function resolveActualModelDir(
  installDir: string
): Promise<string> {
  try {
    const dirExists = await exists(installDir);
    if (!dirExists) {
      return installDir;
    }

    const entries = await readDir(installDir);
    const topLevelFiles = entries.filter((entry) => !entry.isDirectory());
    if (
      topLevelFiles.some((entry) => isNativeModelFileName(entry.name ?? ''))
    ) {
      return installDir;
    }

    const subdirs = entries.filter((entry) => entry.isDirectory());
    const firstSubdir = subdirs[0];
    const singleSubdir = subdirs.length === 1 ? firstSubdir : undefined;

    if (singleSubdir?.path != null) {
      const containsModels = await dirContainsModelFiles(singleSubdir.path);
      if (containsModels) {
        return singleSubdir.path;
      }
    }

    return installDir;
  } catch {
    return installDir;
  }
}

export async function getAvailableDiskSpace(): Promise<number> {
  try {
    const dirExists = await exists(DocumentDirectoryPath);
    if (dirExists) {
      return 10 * 1024 * 1024 * 1024;
    }
  } catch (error) {
    console.warn('Failed to check disk space:', error);
  }

  return 10 * 1024 * 1024 * 1024;
}

export async function checkDiskSpace(
  requiredBytes: number
): Promise<ValidationResult> {
  try {
    const available = await getAvailableDiskSpace();
    const buffer = requiredBytes * 0.2;
    const totalRequired = requiredBytes + buffer;

    if (available < totalRequired) {
      const availableGB = (available / (1024 * 1024 * 1024)).toFixed(2);
      const requiredGB = (totalRequired / (1024 * 1024 * 1024)).toFixed(2);

      return new ValidationResult(
        false,
        'INSUFFICIENT_DISK_SPACE',
        `Insufficient disk space. Available: ${availableGB}GB, Required: ${requiredGB}GB`
      );
    }

    return new ValidationResult(true);
  } catch (error) {
    return new ValidationResult(
      false,
      'INSUFFICIENT_DISK_SPACE',
      `Failed to check disk space: ${String(error)}`
    );
  }
}
