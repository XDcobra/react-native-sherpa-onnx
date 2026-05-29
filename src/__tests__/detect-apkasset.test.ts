let mockPlatformOs = 'android';

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOs;
    },
  },
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

import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveActualModelDir } from '../download/validation';
import {
  resolveFileSourceForDetect,
  resolveFileSourceForModelInit,
} from '../detect/resolveModelInput';

describe('detect resolver bundled and pad FileSources', () => {
  const mockNative = SherpaOnnx as unknown as {
    resolveBundledAssetPath: jest.Mock;
    resolveAppBaseDir: jest.Mock;
    getAssetPackPath: jest.Mock;
  };
  const mockResolveActualModelDir = resolveActualModelDir as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses resolveBundledAssetPath for app:apkAsset on Android', async () => {
    mockPlatformOs = 'android';
    mockNative.resolveBundledAssetPath.mockResolvedValue(
      '/tmp/materialized/models/foo'
    );
    mockResolveActualModelDir.mockResolvedValue('/tmp/materialized/models/foo');

    const resolved = await resolveFileSourceForDetect({
      kind: 'app',
      base: 'apkAsset',
      path: 'models/foo',
    });

    expect(mockNative.resolveBundledAssetPath).toHaveBeenCalledWith(
      'models/foo'
    );
    expect(mockResolveActualModelDir).toHaveBeenCalledWith(
      '/tmp/materialized/models/foo'
    );
    expect(resolved.modelDir).toBe('/tmp/materialized/models/foo');
    expect(resolved.assetName).toBe('foo');
  });

  it('resolveFileSourceForModelInit returns materialized apk asset directory', async () => {
    mockPlatformOs = 'android';
    mockNative.resolveBundledAssetPath.mockResolvedValue(
      '/tmp/materialized/models/bar'
    );
    mockResolveActualModelDir.mockResolvedValue('/tmp/materialized/models/bar');

    const modelDir = await resolveFileSourceForModelInit({
      kind: 'app',
      base: 'apkAsset',
      path: 'models/bar',
    });

    expect(modelDir).toBe('/tmp/materialized/models/bar');
  });

  it('rejects app:apkAsset on non-Android platforms', async () => {
    mockPlatformOs = 'ios';

    await expect(
      resolveFileSourceForDetect({
        kind: 'app',
        base: 'apkAsset',
        path: 'models/foo',
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_UNSUPPORTED_ON_PLATFORM',
    });
  });

  it('uses resolveBundledAssetPath for app:appBundle on iOS', async () => {
    mockPlatformOs = 'ios';
    mockNative.resolveBundledAssetPath.mockResolvedValue(
      '/var/containers/Bundle/Application/ABC/App.app/models/foo'
    );
    mockResolveActualModelDir.mockResolvedValue(
      '/var/containers/Bundle/Application/ABC/App.app/models/foo'
    );

    const resolved = await resolveFileSourceForDetect({
      kind: 'app',
      base: 'appBundle',
      path: 'models/foo',
    });

    expect(mockNative.resolveBundledAssetPath).toHaveBeenCalledWith(
      'models/foo'
    );
    expect(resolved.modelDir).toBe(
      '/var/containers/Bundle/Application/ABC/App.app/models/foo'
    );
  });

  it('rejects app:appBundle on Android', async () => {
    mockPlatformOs = 'android';

    await expect(
      resolveFileSourceForDetect({
        kind: 'app',
        base: 'appBundle',
        path: 'models/foo',
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_UNSUPPORTED_ON_PLATFORM',
    });
  });

  it('resolves app:files via sandbox only on iOS', async () => {
    mockPlatformOs = 'ios';
    mockNative.resolveAppBaseDir.mockResolvedValue(
      '/var/mobile/Library/Application Support'
    );
    mockResolveActualModelDir.mockResolvedValue(
      '/var/mobile/Library/Application Support/models/foo'
    );

    const resolved = await resolveFileSourceForDetect({
      kind: 'app',
      base: 'files',
      path: 'models/foo',
    });

    expect(mockNative.resolveBundledAssetPath).not.toHaveBeenCalled();
    expect(resolved.modelDir).toBe(
      '/var/mobile/Library/Application Support/models/foo'
    );
  });

  it('rejects pad on iOS', async () => {
    mockPlatformOs = 'ios';

    await expect(
      resolveFileSourceForDetect({
        kind: 'pad',
        packName: 'sherpa_models',
        path: 'models/foo',
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_UNSUPPORTED_ON_PLATFORM',
    });
  });

  it('rejects pad on Android when pack is unavailable', async () => {
    mockPlatformOs = 'android';
    mockNative.getAssetPackPath.mockResolvedValue(null);

    await expect(
      resolveFileSourceForDetect({
        kind: 'pad',
        packName: 'missing_pack',
        path: 'models/foo',
      })
    ).rejects.toMatchObject({
      code: 'FILEIO_RESOLVE_ERROR',
    });
  });
});
