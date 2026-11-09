/**
 * Public archive integrity probe via native `probeArchive`.
 * Maps native results to {@link DownloadError} when requested.
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import {
  DownloadError,
  DOWNLOAD_ERROR_CODES,
} from '../download/sources/errors';

export type ProbeArchiveFormat = 'tar.bz2' | 'tar.zst' | 'tar.gz' | 'tar.xz';

export type ProbeArchiveIntegrityOptions = {
  /** When set and file size is smaller → truncated. */
  expectedBytes?: number;
  /**
   * Declared format hint (unused by native auto-detect; kept for API compat).
   * @deprecated Native libarchive auto-detects; this field is ignored.
   */
  format?: ProbeArchiveFormat;
};

export type ProbeArchiveIntegrityOk = {
  ok: true;
  format: ProbeArchiveFormat | null;
  fileSize: number;
};

export type ProbeArchiveIntegrityFail = {
  ok: false;
  code:
    | typeof DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED
    | typeof DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT;
  message: string;
  format: ProbeArchiveFormat | null;
  fileSize: number;
};

export type ProbeArchiveIntegrityResult =
  | ProbeArchiveIntegrityOk
  | ProbeArchiveIntegrityFail;

function asProbeFormat(value: string | undefined): ProbeArchiveFormat | null {
  if (
    value === 'tar.bz2' ||
    value === 'tar.zst' ||
    value === 'tar.gz' ||
    value === 'tar.xz'
  ) {
    return value;
  }
  return null;
}

function mapNativeCode(
  code: string | undefined
): ProbeArchiveIntegrityFail['code'] {
  if (code === DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT) {
    return DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT;
  }
  return DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED;
}

/**
 * Probe a filesystem archive path before extract (native libarchive).
 * Throws {@link DownloadError} when `throwOnFailure` is true (default).
 */
export async function probeArchiveIntegrity(
  filePath: string,
  options?: ProbeArchiveIntegrityOptions & { throwOnFailure?: boolean }
): Promise<ProbeArchiveIntegrityResult> {
  const throwOnFailure = options?.throwOnFailure !== false;
  const expected =
    typeof options?.expectedBytes === 'number' && options.expectedBytes > 0
      ? options.expectedBytes
      : null;

  const native = await SherpaOnnx.probeArchive(filePath, expected);
  const fileSize =
    typeof native.fileSize === 'number' && Number.isFinite(native.fileSize)
      ? native.fileSize
      : 0;
  const format = asProbeFormat(native.format);

  if (native.ok) {
    return { ok: true, format, fileSize };
  }

  const result: ProbeArchiveIntegrityFail = {
    ok: false,
    code: mapNativeCode(native.code),
    message: native.message?.trim() || 'Archive integrity check failed',
    format,
    fileSize,
  };

  if (throwOnFailure) {
    throw new DownloadError(result.code, result.message);
  }
  return result;
}
