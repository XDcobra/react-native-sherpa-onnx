let mockPlatformOs = 'android';

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOs;
    },
  },
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  exists: jest.fn(),
}));

jest.mock('../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    resolveBundledAssetPath: jest.fn(),
    resolveAppBaseDir: jest.fn(),
    getAssetPackPath: jest.fn(),
  },
}));

jest.mock('../download/validation', () => ({
  resolveActualModelDir: jest.fn(),
}));

import { exists } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveActualModelDir } from '../download/validation';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';

describe('FileSource kind auto', () => {
  const mockNative = SherpaOnnx as unknown as {
    resolveBundledAssetPath: jest.Mock;
    resolveAppBaseDir: jest.Mock;
    getAssetPackPath: jest.Mock;
  };
  const mockExists = exists as jest.Mock;
  const mockResolveActualModelDir = resolveActualModelDir as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatformOs = 'android';
  });

  it('rejects kind auto without tryOrder', async () => {
    await expect(
      resolveFileSourceForDetect({
        kind: 'auto',
        path: 'models/foo',
        tryOrder: [],
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_INVALID_ARGUMENT',
      message: expect.stringContaining('tryOrder'),
    });
  });

  it('rejects kind auto when tryOrder is missing', async () => {
    await expect(
      resolveFileSourceForDetect({
        kind: 'auto',
        path: 'models/foo',
      } as never)
    ).rejects.toMatchObject({
      code: 'FILEIO_INVALID_ARGUMENT',
    });
  });

  it('uses first tryOrder target that resolves to an existing directory', async () => {
    mockNative.resolveAppBaseDir.mockResolvedValue('/data/user/0/app/files');
    mockResolveActualModelDir
      .mockResolvedValueOnce('/data/user/0/app/files/models/foo')
      .mockResolvedValueOnce('/data/user/0/app/files/models/foo');
    mockExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    mockNative.resolveBundledAssetPath.mockResolvedValue(
      '/data/user/0/app/files/models/foo'
    );

    const resolved = await resolveFileSourceForDetect({
      kind: 'auto',
      path: 'models/foo',
      tryOrder: ['files', 'apkAsset'],
    });

    expect(mockNative.resolveAppBaseDir).toHaveBeenCalledWith('files');
    expect(mockNative.resolveBundledAssetPath).toHaveBeenCalledWith(
      'models/foo'
    );
    expect(resolved.modelDir).toBe('/data/user/0/app/files/models/foo');
  });

  it('skips unsupported platform targets and continues tryOrder', async () => {
    mockPlatformOs = 'android';
    mockNative.resolveBundledAssetPath.mockResolvedValue(
      '/data/user/0/app/files/models/foo'
    );
    mockResolveActualModelDir.mockResolvedValue(
      '/data/user/0/app/files/models/foo'
    );
    mockExists.mockResolvedValue(true);

    const resolved = await resolveFileSourceForDetect({
      kind: 'auto',
      path: 'models/foo',
      tryOrder: ['appBundle', 'apkAsset'],
    });

    expect(mockNative.resolveBundledAssetPath).toHaveBeenCalledTimes(1);
    expect(resolved.modelDir).toBe('/data/user/0/app/files/models/foo');
  });

  it('fails with NOT_FOUND when no tryOrder target matches', async () => {
    mockNative.resolveAppBaseDir.mockResolvedValue('/data/user/0/app/files');
    mockResolveActualModelDir.mockResolvedValue(
      '/data/user/0/app/files/models/missing'
    );
    mockExists.mockResolvedValue(false);

    await expect(
      resolveFileSourceForDetect({
        kind: 'auto',
        path: 'models/missing',
        tryOrder: ['files', 'fs'],
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_NOT_FOUND',
      message: expect.stringContaining('tryOrder'),
    });
  });

  it('supports pad entries in tryOrder', async () => {
    mockNative.getAssetPackPath.mockResolvedValue('/pad/sherpa_models');
    mockResolveActualModelDir.mockResolvedValue(
      '/pad/sherpa_models/models/foo'
    );
    mockExists.mockResolvedValue(true);

    const resolved = await resolveFileSourceForDetect({
      kind: 'auto',
      path: 'models/foo',
      tryOrder: [{ pad: 'sherpa_models' }],
    });

    expect(mockNative.getAssetPackPath).toHaveBeenCalledWith('sherpa_models');
    expect(resolved.modelDir).toBe('/pad/sherpa_models/models/foo');
  });
});
