jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    configureFileIO: jest.fn().mockResolvedValue(undefined),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { configureFileIO, FileIOErrorCode } from '../index';

const mockNative = SherpaOnnx as unknown as {
  configureFileIO: jest.Mock;
};

describe('configureFileIO', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards default empty options', async () => {
    await configureFileIO();
    expect(mockNative.configureFileIO).toHaveBeenCalledWith({});
  });

  it('forwards noFdCache policy', async () => {
    await configureFileIO({
      noFdCache: { maxBytes: 256 * 1024 * 1024, maxAgeMs: 0 },
    });
    expect(mockNative.configureFileIO).toHaveBeenCalledWith({
      noFdCache: { maxBytes: 256 * 1024 * 1024, maxAgeMs: 0 },
    });
  });

  it('rejects maxBytes <= 0', async () => {
    await expect(
      configureFileIO({ noFdCache: { maxBytes: 0 } })
    ).rejects.toMatchObject({
      code: FileIOErrorCode.INVALID_ARGUMENT,
    });
    expect(mockNative.configureFileIO).not.toHaveBeenCalled();
  });

  it('rejects non-integer maxAgeMs', async () => {
    await expect(
      configureFileIO({ noFdCache: { maxAgeMs: 1.5 } })
    ).rejects.toMatchObject({
      code: FileIOErrorCode.INVALID_ARGUMENT,
    });
    expect(mockNative.configureFileIO).not.toHaveBeenCalled();
  });
});
