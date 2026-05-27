import {
  DOWNLOAD_ERROR_CODES,
  DownloadError,
  isDownloadError,
  isDownloadErrorCode,
  isPauseCompatibleError,
} from '../errors';

describe('download source errors', () => {
  it('exposes the frozen error-code contract', () => {
    expect(Object.values(DOWNLOAD_ERROR_CODES)).toEqual([
      'DOWNLOAD_UNKNOWN_SOURCE',
      'DOWNLOAD_SOURCE_LIST_FAILED',
      'DOWNLOAD_SOURCE_AUTH_FAILED',
      'DOWNLOAD_NETWORK_FAILED',
      'DOWNLOAD_HTTP_STATUS',
      'DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH',
      'DOWNLOAD_INTEGRITY_TRUNCATED',
      'DOWNLOAD_EXTRACT_FAILED',
      'DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT',
      'DOWNLOAD_DISK_SPACE_INSUFFICIENT',
      'DOWNLOAD_CANCELLED',
      'DOWNLOAD_PAUSED',
      'DOWNLOAD_INVALID_LAYOUT',
    ]);
  });

  it('creates typed download errors with metadata', () => {
    const err = new DownloadError(
      DOWNLOAD_ERROR_CODES.HTTP_STATUS,
      'unexpected status 429',
      {
        source: 'github_k2_fsa',
        status: 429,
      }
    );

    expect(err.name).toBe('DownloadError');
    expect(err.code).toBe('DOWNLOAD_HTTP_STATUS');
    expect(err.source).toBe('github_k2_fsa');
    expect(err.status).toBe(429);
    expect(isDownloadError(err)).toBe(true);
  });

  it('checks code literals safely', () => {
    expect(isDownloadErrorCode('DOWNLOAD_CANCELLED')).toBe(true);
    expect(isDownloadErrorCode('DOWNLOAD_NOT_A_REAL_CODE')).toBe(false);
  });

  it('keeps pause compatibility checks', () => {
    const pauseLike = new Error('paused');
    pauseLike.name = 'PauseError';

    const codeLike = new Error('paused') as Error & { code: string };
    codeLike.code = 'DOWNLOAD_PAUSED';

    expect(isPauseCompatibleError(pauseLike)).toBe(true);
    expect(isPauseCompatibleError(codeLike)).toBe(true);
    expect(isPauseCompatibleError(new Error('other'))).toBe(false);
  });
});
