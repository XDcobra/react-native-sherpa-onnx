import type { ModelCategory } from '../types';

export const DOWNLOAD_ERROR_CODES = {
  UNKNOWN_SOURCE: 'DOWNLOAD_UNKNOWN_SOURCE',
  SOURCE_LIST_FAILED: 'DOWNLOAD_SOURCE_LIST_FAILED',
  SOURCE_AUTH_FAILED: 'DOWNLOAD_SOURCE_AUTH_FAILED',
  NETWORK_FAILED: 'DOWNLOAD_NETWORK_FAILED',
  HTTP_STATUS: 'DOWNLOAD_HTTP_STATUS',
  INTEGRITY_CHECKSUM_MISMATCH: 'DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH',
  INTEGRITY_TRUNCATED: 'DOWNLOAD_INTEGRITY_TRUNCATED',
  EXTRACT_FAILED: 'DOWNLOAD_EXTRACT_FAILED',
  EXTRACT_UNSUPPORTED_FORMAT: 'DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT',
  DISK_SPACE_INSUFFICIENT: 'DOWNLOAD_DISK_SPACE_INSUFFICIENT',
  CANCELLED: 'DOWNLOAD_CANCELLED',
  PAUSED: 'DOWNLOAD_PAUSED',
  INVALID_LAYOUT: 'DOWNLOAD_INVALID_LAYOUT',
} as const;

export type DownloadErrorCode =
  (typeof DOWNLOAD_ERROR_CODES)[keyof typeof DOWNLOAD_ERROR_CODES];

export type DownloadErrorMetadata = {
  source?: string;
  category?: ModelCategory;
  status?: number;
  modelId?: string;
  cause?: unknown;
};

export class DownloadError extends Error {
  public readonly code: DownloadErrorCode;
  public readonly source?: string;
  public readonly category?: ModelCategory;
  public readonly status?: number;
  public readonly modelId?: string;
  override readonly cause?: unknown;

  constructor(
    code: DownloadErrorCode,
    message: string,
    metadata?: DownloadErrorMetadata
  ) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.source = metadata?.source;
    this.category = metadata?.category;
    this.status = metadata?.status;
    this.modelId = metadata?.modelId;
    this.cause = metadata?.cause;
  }
}

export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError;
}

export function isDownloadErrorCode(value: string): value is DownloadErrorCode {
  return Object.values(DOWNLOAD_ERROR_CODES).includes(
    value as DownloadErrorCode
  );
}

export function isPauseCompatibleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'PauseError') {
    return true;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === DOWNLOAD_ERROR_CODES.PAUSED;
}
