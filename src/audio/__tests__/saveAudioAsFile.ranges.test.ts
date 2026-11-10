jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    saveAudioBufferToFile: jest.fn(async () => ({
      outputKind: 'fs',
      outputPath: '/tmp/out.wav',
    })),
    saveFileAsAudioFile: jest.fn(async () => ({
      outputKind: 'fs',
      outputPath: '/tmp/out.wav',
    })),
    cancelAudioSave: jest.fn(async () => undefined),
  },
}));

jest.mock('../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: (id: string) => id,
}));

jest.mock('../../fileio/platformValidation', () => ({
  assertFileDestinationSupportedOnPlatform: jest.fn(),
  assertFileSourceSupportedOnPlatform: jest.fn(),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { saveAudioAsFile } from '../index';
import { AudioSaveErrorCode } from '../types';

const mockSaveBuffer = SherpaOnnx.saveAudioBufferToFile as jest.Mock;
const mockSaveFile = SherpaOnnx.saveFileAsAudioFile as jest.Mock;

describe('saveAudioAsFile ranges plumbing', () => {
  beforeEach(() => {
    mockSaveBuffer.mockClear();
    mockSaveFile.mockClear();
  });

  it('passes null ranges when omitted', async () => {
    await saveAudioAsFile(
      'off_abc',
      { kind: 'fs', path: '/tmp/out.wav' },
      'wav'
    );
    expect(mockSaveBuffer).toHaveBeenCalledWith(
      'off_abc',
      { kind: 'fs', path: '/tmp/out.wav' },
      'wav',
      0,
      0,
      0,
      expect.any(String),
      null
    );
  });

  it('normalizes ranges before native call', async () => {
    await saveAudioAsFile(
      'off_abc',
      { kind: 'fs', path: '/tmp/out.wav' },
      'wav',
      {
        ranges: [
          { startMs: 100, endMs: 200 },
          { startMs: 150, endMs: 250 },
        ],
      }
    );
    expect(mockSaveBuffer.mock.calls[0][7]).toEqual([
      { startMs: 100, endMs: 250 },
    ]);
  });

  it('rejects invalid ranges before native', async () => {
    await expect(
      saveAudioAsFile('off_abc', { kind: 'fs', path: '/tmp/out.wav' }, 'wav', {
        ranges: [{ startMs: 10, endMs: 5 }],
      })
    ).rejects.toMatchObject({ code: AudioSaveErrorCode.INVALID_RANGE });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('plumbs ranges on FileSource path', async () => {
    await saveAudioAsFile(
      { kind: 'fs', path: '/tmp/in.opus' },
      { kind: 'fs', path: '/tmp/out.wav' },
      'wav',
      { ranges: [{ startMs: 0, endMs: 500 }] }
    );
    expect(mockSaveFile.mock.calls[0][7]).toEqual([{ startMs: 0, endMs: 500 }]);
  });
});
