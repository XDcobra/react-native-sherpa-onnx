import { DownloadError, DOWNLOAD_ERROR_CODES } from './errors';
import type { SourceArchiveFormat, SourceAssetLayout } from './types';

export const SUPPORTED_ARCHIVE_FORMATS: readonly SourceArchiveFormat[] = [
  'tar.bz2',
  'tar.gz',
  'tar.xz',
  'tar.zst',
] as const;

export function isSupportedArchiveFormat(
  format: string
): format is SourceArchiveFormat {
  return (SUPPORTED_ARCHIVE_FORMATS as readonly string[]).includes(format);
}

export function assertSupportedLayout(layout: SourceAssetLayout): void {
  if (layout.kind !== 'archive') {
    return;
  }

  if (!isSupportedArchiveFormat(layout.format)) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT,
      `Unsupported archive format: ${layout.format}`
    );
  }
}

export function assertValidLayoutAssets(opts: {
  layout: SourceAssetLayout;
  assetCount: number;
}): void {
  if (opts.layout.kind === 'archive' && opts.assetCount !== 1) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.INVALID_LAYOUT,
      'Archive layout requires exactly one asset'
    );
  }

  if (opts.layout.kind === 'folder' && opts.assetCount < 1) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.INVALID_LAYOUT,
      'Folder layout requires at least one asset'
    );
  }
}
