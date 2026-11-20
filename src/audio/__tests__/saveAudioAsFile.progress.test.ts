type ProgressListener = (event: unknown) => void;

const mockRemove = jest.fn();
const mockAddListener = jest.fn(
  (_eventName: string, _handler: ProgressListener) => ({ remove: mockRemove })
);

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: mockAddListener,
  })),
  NativeModules: { SherpaOnnx: {} },
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    saveAudioBufferToFile: jest.fn(),
    saveFileAsAudioFile: jest.fn(),
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
import type { AudioSaveProgressEvent } from '../types';

const mockSaveBuffer = SherpaOnnx.saveAudioBufferToFile as jest.Mock;
const mockSaveFile = SherpaOnnx.saveFileAsAudioFile as jest.Mock;
const mockCancel = SherpaOnnx.cancelAudioSave as jest.Mock;

const OUT = { kind: 'fs' as const, path: '/tmp/out.wav' };
const OK = { outputKind: 'fs', outputPath: '/tmp/out.wav' };

/** Native mock that emits the given events (operationId filled in) before resolving. */
function nativeEmitting(
  events: Array<Partial<AudioSaveProgressEvent> & { operationId?: string }>
) {
  return async (...args: unknown[]) => {
    const operationId = args[6] as string;
    const handler = mockAddListener.mock.calls[0]?.[1];
    for (const e of events) handler?.({ operationId, ...e });
    return OK;
  };
}

describe('saveAudioAsFile progress', () => {
  beforeEach(() => {
    mockAddListener.mockClear();
    mockRemove.mockClear();
    mockSaveBuffer.mockReset();
    mockSaveFile.mockReset();
    mockCancel.mockClear();
  });

  it('does not subscribe without onProgress', async () => {
    mockSaveBuffer.mockResolvedValue(OK);
    await saveAudioAsFile('off_a', OUT, 'wav');
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('forwards native events of this operation and ends with one 100 % event', async () => {
    mockSaveBuffer.mockImplementation(
      nativeEmitting([
        {
          phase: 'encode',
          framesProcessed: 4096,
          totalFramesEstimate: 16384,
          percent: 25,
        },
        {
          phase: 'encode',
          framesProcessed: 8192,
          totalFramesEstimate: 16384,
          percent: 50,
        },
        {
          operationId: 'save_other',
          phase: 'encode',
          framesProcessed: 1,
          totalFramesEstimate: 2,
          percent: 50,
        },
        {
          phase: 'finalize',
          framesProcessed: 16384,
          totalFramesEstimate: 16384,
          percent: 100,
        },
      ])
    );
    const seen: AudioSaveProgressEvent[] = [];
    await saveAudioAsFile('off_a', OUT, 'wav', {
      onProgress: (e) => seen.push(e),
    });

    expect(mockAddListener).toHaveBeenCalledWith(
      'audioSaveProgress',
      expect.any(Function)
    );
    const operationId = mockSaveBuffer.mock.calls[0][6];
    expect(seen.every((e) => e.operationId === operationId)).toBe(true);
    expect(seen.map((e) => [e.phase, e.percent])).toEqual([
      ['encode', 25],
      ['encode', 50],
      ['finalize', 100],
    ]);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('sends the final 100 % itself when the native one arrives after resolve', async () => {
    mockSaveFile.mockImplementation(
      nativeEmitting([
        {
          phase: 'encode',
          framesProcessed: 900,
          totalFramesEstimate: 1000,
          percent: 90,
        },
      ])
    );
    const seen: AudioSaveProgressEvent[] = [];
    await saveAudioAsFile({ kind: 'fs', path: '/tmp/in.mp3' }, OUT, 'wav', {
      onProgress: (e) => seen.push(e),
    });

    expect(seen[seen.length - 1]).toMatchObject({
      phase: 'finalize',
      percent: 100,
      framesProcessed: 900,
      totalFramesEstimate: 900,
    });
    expect(seen.filter((e) => e.phase === 'finalize')).toHaveLength(1);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('sends no final event and unsubscribes when native rejects', async () => {
    mockSaveBuffer.mockImplementation(async (...args: unknown[]) => {
      const handler = mockAddListener.mock.calls[0]?.[1];
      handler?.({
        operationId: args[6],
        phase: 'encode',
        framesProcessed: 10,
        totalFramesEstimate: 100,
        percent: 10,
      });
      throw Object.assign(new Error('boom'), {
        code: 'AUDIO_SAVE_ENCODE_ERROR',
      });
    });
    const seen: AudioSaveProgressEvent[] = [];
    await expect(
      saveAudioAsFile('off_a', OUT, 'mp3', { onProgress: (e) => seen.push(e) })
    ).rejects.toMatchObject({ code: 'AUDIO_SAVE_ENCODE_ERROR' });
    expect(seen.map((e) => e.phase)).toEqual(['encode']);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('abort during the save calls cancelAudioSave with the operation id', async () => {
    const controller = new AbortController();
    mockSaveBuffer.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('cancelled'), {
        code: 'AUDIO_SAVE_CANCELLED',
      });
    });
    await expect(
      saveAudioAsFile('off_a', OUT, 'wav', {
        signal: controller.signal,
        onProgress: () => {},
      })
    ).rejects.toMatchObject({ code: 'AUDIO_SAVE_CANCELLED' });
    expect(mockCancel).toHaveBeenCalledWith(mockSaveBuffer.mock.calls[0][6]);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('an already aborted signal rejects before native and unsubscribes', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      saveAudioAsFile('off_a', OUT, 'wav', {
        signal: controller.signal,
        onProgress: () => {},
      })
    ).rejects.toMatchObject({ code: 'AUDIO_SAVE_CANCELLED' });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
