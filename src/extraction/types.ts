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
};

/** Result returned by `extractArchive`. */
export type ExtractResult = {
  success: boolean;
  /** Absolute path to the extracted directory (on success). */
  path?: string;
  /** SHA-256 hex digest of the source archive (when available). */
  sha256?: string;
  /** Error description (on failure). */
  reason?: string;
};

/** Options for `extractArchive`. */
export type ExtractArchiveOptions = {
  /** Overwrite existing files. Defaults to `true`. */
  force?: boolean;
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
