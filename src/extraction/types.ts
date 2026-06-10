/**
 * Types for the extraction subpath.
 *
 * A BundledArchive describes a compressed model archive (.tar.zst or .tar.bz2)
 * that can come from two distinct sources:
 *
 *  1. **Filesystem** — a regular file on disk (PAD STORAGE_FILES, iOS bundle,
 *     downloaded archive, etc.). `fromAsset` is absent or `false`.
 *  2. **Android APK asset** — embedded in the APK via PAD APK_ASSETS.
 *     `fromAsset` is `true`; extraction streams directly from the APK.
 *
 * The consumer does not need to distinguish between the two:
 * `extractArchive()` handles both transparently.
 */

/** Describes one compressed model archive. */
export type BundledArchive = {
  /** Identifier derived from the archive filename (filename minus the extension). */
  modelId: string;
  /**
   * Path to the archive.
   * - Filesystem archives: absolute path (e.g. `/data/.../models/whisper-tiny.tar.zst`).
   * - APK assets: asset path (e.g. `asset_packs/sherpa_models/assets/whisper-tiny.tar.zst`).
   */
  archivePath: string;
  /** Compression format. */
  format: 'tar.zst' | 'tar.bz2';
  /** File size in bytes (available for filesystem archives; 0 or absent for APK assets). */
  fileSize?: number;
  /** `true` when the archive lives inside the APK (APK_ASSETS). Absent for filesystem archives. */
  fromAsset?: boolean;
};

/** Progress event emitted during extraction. */
export type ExtractProgressEvent = {
  /** Bytes extracted so far. */
  bytes: number;
  /** Total bytes of the archive (may be 0 when unknown). */
  totalBytes: number;
  /** Progress percentage 0–100. */
  percent: number;
  /** Native archive entry index (resume / diagnostics). */
  entryIndex?: number;
  /** Matches `operationId` passed to native `extractArchive` (when emitted). */
  operationId?: string;
};

/** Result from unified archive extraction (path or asset stream) — native TurboModule payload. */
export type ExtractArchiveResult = {
  success: boolean;
  /** True when extraction stopped due to cancel (resume with skipEntries = lastEntryIndex + 1). */
  paused: boolean;
  lastEntryIndex: number;
  lastEntryPath: string;
  bytesExtracted: number;
  path?: string;
  sha256?: string;
  reason?: string;
};

/**
 * Result returned by `extractArchive` / `extractTarBz2`.
 * Failures other than native pause throw; `paused` is returned so callers can persist resume metadata.
 */
export type ExtractResult =
  | {
      success: true;
      path?: string;
      sha256?: string;
    }
  | {
      success: false;
      paused: true;
      lastEntryIndex: number;
      lastEntryPath: string;
      bytesExtracted: number;
      reason?: string;
    };

/** Options for `extractArchive`. */
export type ExtractArchiveOptions = {
  /** Overwrite existing files. Defaults to `true`. */
  force?: boolean;
  /**
   * Resume: skip the first N archive entries (from a paused native result). Default 0.
   */
  skipEntries?: number;
  /**
   * Per-operation ID for native cancel (`cancelExtraction`) and progress correlation.
   * Defaults to `archive.archivePath`.
   */
  operationId?: string;
  /** Callback for extraction progress. */
  onProgress?: (event: ExtractProgressEvent) => void;
  /** AbortSignal to cancel the extraction. */
  signal?: AbortSignal;
  /**
   * **Android:** When true (default), the native layer posts a system notification with extraction
   * progress. Set to false to disable (e.g. first-run bundled-model prep with in-app UI only).
   * **iOS:** Accepted for API parity; no notification is shown.
   */
  showNotificationsEnabled?: boolean;
  /** **Android:** Notification title. Default: generic “unpacking” title. Ignored on iOS. */
  notificationTitle?: string;
  /** **Android:** Notification body (progress text is appended). Default: generic. Ignored on iOS. */
  notificationText?: string;
};

/** Subset of `ExtractArchiveOptions` passed through to path- and asset-stream extractors. */
export type ExtractNotificationArgs = Pick<
  ExtractArchiveOptions,
  'showNotificationsEnabled' | 'notificationTitle' | 'notificationText'
>;
