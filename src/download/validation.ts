import RNFS from 'react-native-fs';
import { sha256 } from 'react-native-hashkit';

export type ValidationError =
  | 'CHECKSUM_MISMATCH'
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
 * Parse checksum.txt format into a Map of filename -> hash
 * Expected format:
 * filename\tsha256hash
 * example:
 * vits-vctk.tar.bz2	4f0a02db66914b3760b144cebc004e65dd4d1aeef43379f2b058849e74002490
 */
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

/**
 * Calculate SHA256 hash of a file
 * Uses react-native-hashkit for efficient SHA256 calculation
 */
export async function calculateFileChecksum(filePath: string): Promise<string> {
  try {
    const hash = await sha256(filePath);
    return hash.toLowerCase();
  } catch (error) {
    throw new Error(`Failed to calculate checksum: ${error}`);
  }
}

/**
 * Validate checksum of downloaded file
 */
export async function validateChecksum(
  filePath: string,
  expectedChecksum: string
): Promise<ValidationResult> {
  try {
    const actualChecksum = await calculateFileChecksum(filePath);
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
      'CHECKSUM_MISMATCH',
      `Failed to validate checksum: ${error}`
    );
  }
}

/**
 * Validate that extraction was successful by checking:
 * - Directory exists and is not empty
 * - Contains at least some files (not just directories)
 *
 * The actual model validation (correct files for specific model type)
 * is delegated to the native DetectSttModel / DetectTtsModel functions,
 * so we don't need to check for specific filenames here.
 */
export async function validateExtractedFiles(
  modelDir: string,
  _category: string
): Promise<ValidationResult> {
  try {
    const dirExists = await RNFS.exists(modelDir);
    if (!dirExists) {
      return new ValidationResult(
        false,
        'MISSING_FILES',
        `Model directory does not exist: ${modelDir}`
      );
    }

    const isModelLikeFile = (name: string) => {
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
    ): Promise<RNFS.ReadDirItem[]> => {
      if (depth > maxDepth) return [];

      const entries = await RNFS.readDir(dir);
      const files: RNFS.ReadDirItem[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nested = await collectFilesRecursive(
            entry.path,
            depth + 1,
            maxDepth
          );
          files.push(...nested);
        } else {
          files.push(entry);
        }
      }

      return files;
    };

    const entries = await RNFS.readDir(modelDir);
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
      isModelLikeFile(file.name)
    );

    if (!hasModelLikeFiles) {
      const nestedFiles = await collectFilesRecursive(modelDir);
      hasModelLikeFiles = nestedFiles.some((file) =>
        isModelLikeFile(file.name)
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
      `Failed to validate extracted files: ${error}`
    );
  }
}

/**
 * Get available disk space (in bytes)
 * This is a simplified version. For accurate values on Android/iOS, use native modules.
 */
export async function getAvailableDiskSpace(): Promise<number> {
  try {
    // Try to get the document directory (simple check for availability)
    const dirExists = await RNFS.exists(RNFS.DocumentDirectoryPath);
    if (dirExists) {
      // Default to 10GB for modern devices
      // In production, integrate native disk space calculation
      return 10 * 1024 * 1024 * 1024; // 10GB
    }
  } catch (error) {
    console.warn('Failed to check disk space:', error);
  }

  // Fallback: return 10GB estimate for modern devices
  return 10 * 1024 * 1024 * 1024;
}

/**
 * Check if there's enough disk space for download
 * Adds 20% buffer to the required size
 */
export async function checkDiskSpace(
  requiredBytes: number
): Promise<ValidationResult> {
  try {
    const available = await getAvailableDiskSpace();
    const buffer = requiredBytes * 0.2; // 20% safety buffer
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
      `Failed to check disk space: ${error}`
    );
  }
}

/**
 * Update expected files configuration for a category
 * DEPRECATED: The native DetectSttModel/DetectTtsModel functions handle model validation.
 * This function is kept for backward compatibility but does nothing.
 */
export function setExpectedFilesForCategory(
  _category: string,
  _files: string[]
): void {
  // No-op: validation is now handled by native detect functions
}

/**
 * Get expected files for a category
 * DEPRECATED: The native DetectSttModel/DetectTtsModel functions handle model validation.
 * This function is kept for backward compatibility.
 */
export function getExpectedFilesForCategory(_category: string): string[] {
  // Return empty array: validation is now handled by native detect functions
  return [];
}
