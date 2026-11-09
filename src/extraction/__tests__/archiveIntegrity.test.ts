/** Unit tests for probeArchiveIntegrity (NativeSherpaOnnx.probeArchive mocked). */

const mockProbeArchive = jest.fn();

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    probeArchive: (...args: unknown[]) => mockProbeArchive.apply(null, args),
  },
}));

import { probeArchiveIntegrity } from '../archiveIntegrity';
import { DOWNLOAD_ERROR_CODES } from '../../download/sources/errors';

describe('probeArchiveIntegrity (JS → native)', () => {
  beforeEach(() => {
    mockProbeArchive.mockReset();
  });

  it('maps native ok to ProbeArchiveIntegrityOk', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: true,
      fileSize: 42,
      format: 'tar.zst',
    });
    const result = await probeArchiveIntegrity('/tmp/a.tar.zst', {
      throwOnFailure: false,
    });
    expect(result).toEqual({
      ok: true,
      format: 'tar.zst',
      fileSize: 42,
    });
    expect(mockProbeArchive).toHaveBeenCalledWith('/tmp/a.tar.zst', null);
  });

  it('passes expectedBytes to native', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: true,
      fileSize: 100,
      format: 'tar.bz2',
    });
    await probeArchiveIntegrity('/tmp/a.tar.bz2', {
      expectedBytes: 100,
      throwOnFailure: false,
    });
    expect(mockProbeArchive).toHaveBeenCalledWith('/tmp/a.tar.bz2', 100);
  });

  it('throws DownloadError on native fail by default', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: false,
      fileSize: 10,
      format: 'tar.zst',
      code: DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED,
      message: 'Archive is truncated (10/99 bytes)',
    });
    await expect(probeArchiveIntegrity('/tmp/a.tar.zst')).rejects.toMatchObject(
      {
        code: DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED,
        message: 'Archive is truncated (10/99 bytes)',
      }
    );
  });

  it('returns fail result when throwOnFailure=false', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: false,
      fileSize: 0,
      code: DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT,
      message: 'Unrecognized archive format',
    });
    const result = await probeArchiveIntegrity('/tmp/bad.bin', {
      throwOnFailure: false,
    });
    expect(result).toEqual({
      ok: false,
      code: DOWNLOAD_ERROR_CODES.EXTRACT_UNSUPPORTED_FORMAT,
      message: 'Unrecognized archive format',
      format: null,
      fileSize: 0,
    });
  });
});
