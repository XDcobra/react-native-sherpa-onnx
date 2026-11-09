/**
 * extractArchive must run native probe before native extract, and must not
 * call extract when the probe fails.
 */

const mockProbeArchive = jest.fn();
const mockExtractArchiveNative = jest.fn(async () => ({
  success: true,
  path: '/tmp/out',
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  exists: jest.fn(async () => true),
  stat: jest.fn(async () => ({ size: 1 })),
  readDir: jest.fn(async () => []),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DeviceEventEmitter: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    probeArchive: (...args: unknown[]) => mockProbeArchive.apply(null, args),
    extractArchive: (...args: unknown[]) =>
      mockExtractArchiveNative.apply(null, args),
    cancelExtraction: jest.fn(),
  },
}));

import { extractArchive } from '../index';
import { DOWNLOAD_ERROR_CODES } from '../../download/sources/errors';

describe('extractArchive probe → native guard', () => {
  beforeEach(() => {
    mockProbeArchive.mockReset();
    mockExtractArchiveNative.mockClear();
    mockExtractArchiveNative.mockResolvedValue({
      success: true,
      path: '/tmp/out',
    });
  });

  it('calls native extract after probe passes', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: true,
      fileSize: 100,
      format: 'tar.zst',
    });
    const result = await extractArchive(
      {
        modelId: 'fixture',
        archivePath: '/tmp/ok.tar.zst',
        format: 'tar.zst',
        fileSize: 100,
      },
      '/tmp/out',
      { force: true, showNotificationsEnabled: false }
    );
    expect(result.success).toBe(true);
    expect(mockProbeArchive).toHaveBeenCalled();
    expect(mockExtractArchiveNative).toHaveBeenCalledTimes(1);
  });

  it('does not call native extract when probe fails', async () => {
    mockProbeArchive.mockResolvedValue({
      ok: false,
      fileSize: 4,
      format: 'tar.zst',
      code: DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED,
      message: 'Archive magic mismatch',
    });
    await expect(
      extractArchive(
        {
          modelId: 'fixture',
          archivePath: '/tmp/bad.bin',
          format: 'tar.zst',
          fileSize: 4,
        },
        '/tmp/out',
        { force: true, showNotificationsEnabled: false }
      )
    ).rejects.toMatchObject({
      code: DOWNLOAD_ERROR_CODES.INTEGRITY_TRUNCATED,
    });
    expect(mockExtractArchiveNative).not.toHaveBeenCalled();
  });

  it('skips probe when skipIntegrityProbe is true', async () => {
    const result = await extractArchive(
      {
        modelId: 'fixture',
        archivePath: '/tmp/ok.tar.zst',
        format: 'tar.zst',
        fileSize: 100,
      },
      '/tmp/out',
      {
        force: true,
        showNotificationsEnabled: false,
        skipIntegrityProbe: true,
      }
    );
    expect(result.success).toBe(true);
    expect(mockProbeArchive).not.toHaveBeenCalled();
    expect(mockExtractArchiveNative).toHaveBeenCalledWith(
      '/tmp/ok.tar.zst',
      '/tmp/out',
      true,
      0,
      '/tmp/ok.tar.zst',
      false,
      undefined,
      undefined,
      true
    );
  });
});
