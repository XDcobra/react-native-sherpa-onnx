/**
 * File I/O types for react-native-sherpa-onnx/fileio.
 *
 * Unified, type-safe location model for file sources and destinations
 * across Android (SAF, PAD) and iOS (local paths, security-scoped URLs).
 */

// ========== Location Types ==========

/**
 * Well-known app-relative base directories.
 * The native resolver maps these to platform-specific absolute paths.
 */
export type AppBaseDir =
  | 'cache'
  | 'documents'
  | 'files'
  | 'tmp'
  | 'externalFiles'
  /**
   * Android APK bundled assets (e.g. `android/app/src/main/assets/...`).
   * This is intentionally distinct from sandboxed `files`.
   */
  | 'apkAsset';

/**
 * Discriminated union describing where to read a file from.
 * Native resolvers map each kind to platform-appropriate I/O.
 */
export type FileSource =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | {
      kind: 'contentUri';
      uri: string;
      /** Optional file name hint for demuxer selection (extension). */ displayName?: string;
    }
  | { kind: 'securityScoped'; uri: string; displayName?: string }
  | { kind: 'pad'; packName: string; path: string };

/**
 * Discriminated union describing where to write a file to.
 * Platform-incompatible kinds fail with FILEIO_UNSUPPORTED_ON_PLATFORM.
 */
export type FileDestination =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | { kind: 'contentUri'; uri: string }
  | {
      kind: 'contentTree';
      treeUri: string;
      filename: string;
      /** Required. MIME type for the created SAF document. */
      mimeType: string;
    }
  | { kind: 'securityScoped'; uri: string };

/**
 * Canonical reference to a file after a write/copy operation.
 * Always contains the concrete location the file was written to.
 */
export type ResolvedFileRef =
  | { kind: 'fs'; path: string }
  | { kind: 'contentUri'; uri: string };

// ========== Options ==========

/**
 * Progress event emitted during file I/O operations (copy, conversion).
 */
export interface FileIOProgressEvent {
  /** Bytes transferred so far. */
  bytesTransferred: number;
  /** Total bytes (0 if unknown, e.g. content:// streams without Content-Length). */
  totalBytes: number;
  /** Progress percentage 0–100 (0 when totalBytes is unknown). */
  percent: number;
}

export interface CopyFileOptions {
  /**
   * Overwrite existing file at destination.
   * @default true
   */
  overwrite?: boolean;
  /** Create parent directories if they don't exist (fs/app destinations only). */
  createParentDirectories?: boolean;
  /** AbortSignal to cancel the copy. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: FileIOProgressEvent) => void;
}

export interface CopyFileResult {
  /** Number of bytes written. */
  bytesCopied: number;
  /** Canonical reference to the output file. */
  output: ResolvedFileRef;
}

export interface SaveTextOptions {
  /**
   * Text encoding.
   * @default 'utf8'
   */
  encoding?: 'utf8';
  /**
   * Overwrite existing file at destination.
   * @default true
   */
  overwrite?: boolean;
}

export interface ShareFileOptions {
  /** MIME type for the share intent. Inferred from file extension if omitted. */
  mimeType?: string;
  /** Android: chooser title. iOS: ignored. */
  title?: string;
}

// ========== Error Codes ==========

export const FileIOErrorCode = {
  /** Argument validation failed (invalid kind, missing required field, etc.) */
  INVALID_ARGUMENT: 'FILEIO_INVALID_ARGUMENT',
  /** The location kind is not recognized. */
  UNSUPPORTED_LOCATION_KIND: 'FILEIO_UNSUPPORTED_LOCATION_KIND',
  /** The location kind is valid but not supported on this platform. */
  UNSUPPORTED_ON_PLATFORM: 'FILEIO_UNSUPPORTED_ON_PLATFORM',
  /** Missing or expired SAF/security-scoped permission. */
  PERMISSION_DENIED: 'FILEIO_PERMISSION_DENIED',
  /** Source file/URI not found. */
  NOT_FOUND: 'FILEIO_NOT_FOUND',
  /** Destination already exists and overwrite is false. */
  ALREADY_EXISTS: 'FILEIO_ALREADY_EXISTS',
  /** Error reading from source. */
  READ_ERROR: 'FILEIO_READ_ERROR',
  /** Error writing to destination. */
  WRITE_ERROR: 'FILEIO_WRITE_ERROR',
  /** Failed to resolve source or destination to a native handle. */
  RESOLVE_ERROR: 'FILEIO_RESOLVE_ERROR',
  /** Operation was cancelled via AbortSignal / cancelFileIO. */
  CANCELLED: 'FILEIO_CANCELLED',
  /** The app base dir path traversal was blocked by the security whitelist. */
  PATH_TRAVERSAL_BLOCKED: 'FILEIO_PATH_TRAVERSAL_BLOCKED',
} as const;

export type FileIOErrorCodeValue =
  (typeof FileIOErrorCode)[keyof typeof FileIOErrorCode];
