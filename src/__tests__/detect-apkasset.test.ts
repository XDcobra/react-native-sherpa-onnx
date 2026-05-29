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
    resolveModelPath: jest.fn(),
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

describe('detect resolver with app:apkAsset', () => {
  const mockNative = SherpaOnnx as unknown as {
    resolveModelPath: jest.Mock;
    resolveAppBaseDir: jest.Mock;
  };
  const mockResolveActualModelDir = resolveActualModelDir as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses resolveModelPath for app:apkAsset on Android', async () => {
    mockPlatformOs = 'android';
    mockNative.resolveModelPath.mockResolvedValue(
      '/tmp/materialized/models/foo'
    );
    mockResolveActualModelDir.mockResolvedValue('/tmp/materialized/models/foo');

    const resolved = await resolveFileSourceForDetect({
      kind: 'app',
      base: 'apkAsset',
      path: 'models/foo',
    });

    expect(mockNative.resolveModelPath).toHaveBeenCalledWith({
      type: 'asset',
      path: 'models/foo',
    });
    expect(mockResolveActualModelDir).toHaveBeenCalledWith(
      '/tmp/materialized/models/foo'
    );
    expect(resolved.modelDir).toBe('/tmp/materialized/models/foo');
    expect(resolved.assetName).toBe('foo');
  });

  it('resolveFileSourceForModelInit returns materialized apk asset directory', async () => {
    mockPlatformOs = 'android';
    mockNative.resolveModelPath.mockResolvedValue(
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
});
