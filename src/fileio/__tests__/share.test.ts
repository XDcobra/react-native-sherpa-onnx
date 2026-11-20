jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    shareFiles: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { FileIOErrorCode, shareFile, shareFiles } from '../index';

const mockNative = SherpaOnnx as unknown as { shareFiles: jest.Mock };

const wav = { kind: 'fs', path: '/tmp/a.wav' } as const;
const txt = { kind: 'fs', path: '/tmp/a.txt' } as const;

describe('shareFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.shareFiles.mockResolvedValue({
      completed: true,
      activityType: 'com.apple.UIKit.activity.Mail',
    });
  });

  it('shares several files in one call with the options', async () => {
    const anchor = { x: 10, y: 20, width: 44, height: 44 };
    const result = await shareFiles([wav, txt], { title: 'Export', anchor });
    expect(mockNative.shareFiles).toHaveBeenCalledWith([wav, txt], {
      mimeType: '',
      title: 'Export',
      anchor,
    });
    expect(result).toEqual({
      completed: true,
      activityType: 'com.apple.UIKit.activity.Mail',
    });
  });

  it('shareFile is shareFiles with one source', async () => {
    await shareFile(wav, { mimeType: 'audio/wav' });
    expect(mockNative.shareFiles).toHaveBeenCalledWith([wav], {
      mimeType: 'audio/wav',
      title: '',
    });
  });

  it('maps a platform without a result to nulls', async () => {
    mockNative.shareFiles.mockResolvedValue({
      completed: null,
      activityType: null,
    });
    await expect(shareFile(wav)).resolves.toEqual({
      completed: null,
      activityType: null,
    });
  });

  it('rejects an empty list, an auto source and a bad anchor', async () => {
    await expect(shareFiles([])).rejects.toMatchObject({
      code: FileIOErrorCode.INVALID_ARGUMENT,
    });
    await expect(
      shareFile({ kind: 'auto', path: 'x' } as never)
    ).rejects.toMatchObject({ code: FileIOErrorCode.INVALID_ARGUMENT });
    await expect(
      shareFile(wav, { anchor: { x: NaN, y: 0, width: 1, height: 1 } })
    ).rejects.toMatchObject({ code: FileIOErrorCode.INVALID_ARGUMENT });
    expect(mockNative.shareFiles).not.toHaveBeenCalled();
  });
});
