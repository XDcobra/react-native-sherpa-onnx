/**
 * Temporary overrides for release `checksum.txt` entries that no longer match
 * the published GitHub release assets (assets re-uploaded without updating the
 * checksum file). Prefer upstream fixes; remove entries once checksum.txt is
 * corrected.
 *
 * Verified 2026-11-09 against:
 * https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/
 */
const KNOWN_ARCHIVE_CHECKSUM_OVERRIDES: Readonly<Record<string, string>> = {
  'sherpa-onnx-spleeter-2stems.tar.bz2':
    'e26401d9c1801f43c0229731d78d32c2e80085e3aceedeb25f29d2de5fa68ca2',
  'sherpa-onnx-spleeter-2stems-int8.tar.bz2':
    'c5dc8edfa08cc9a6d82670fcca15cfe671e446385e1a28c9da8c1816d238ea17',
  'sherpa-onnx-spleeter-2stems-fp16.tar.bz2':
    'd54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2',
};

function archiveBasename(pathOrName: string): string {
  const trimmed = pathOrName.trim();
  if (!trimmed) {
    return '';
  }
  const segments = trimmed.split(/[/\\]/);
  return (segments[segments.length - 1] ?? trimmed).trim();
}

/** Expected SHA-256 for a known stale release asset, if any. */
export function knownArchiveChecksumOverride(
  pathOrFilename: string
): string | undefined {
  const name = archiveBasename(pathOrFilename).toLowerCase();
  if (!name) {
    return undefined;
  }
  for (const [filename, sha] of Object.entries(
    KNOWN_ARCHIVE_CHECKSUM_OVERRIDES
  )) {
    if (filename.toLowerCase() === name) {
      return sha.toLowerCase();
    }
  }
  return undefined;
}

/**
 * Prefer a known override when present; otherwise keep the published checksum.
 */
export function resolveArchiveChecksum(
  pathOrFilename: string,
  publishedSha256?: string | null
): string | undefined {
  const override = knownArchiveChecksumOverride(pathOrFilename);
  if (override) {
    return override;
  }
  const published = publishedSha256?.trim();
  return published && published.length > 0
    ? published.toLowerCase()
    : undefined;
}

/** Mutates a checksum map (filename → sha256) with known overrides. */
export function applyKnownChecksumOverrides(
  checksums: Map<string, string>
): Map<string, string> {
  for (const [filename, sha] of Object.entries(
    KNOWN_ARCHIVE_CHECKSUM_OVERRIDES
  )) {
    checksums.set(filename, sha.toLowerCase());
  }
  return checksums;
}
