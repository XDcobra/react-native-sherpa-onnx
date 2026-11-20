jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
  NativeModules: { SherpaOnnx: {} },
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    synthesizeTts: jest.fn(),
    cancelTtsGeneration: jest.fn(() => true),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { synthesizeTtsWithProgress } from '../synthesizeWithProgress';

const native = SherpaOnnx as unknown as {
  synthesizeTts: jest.Mock;
  cancelTtsGeneration: jest.Mock;
};

describe('synthesizeTtsWithProgress cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the plain call without progress and signal', async () => {
    native.synthesizeTts.mockResolvedValue(undefined);

    await synthesizeTtsWithProgress('tts_1', 'txt_off_1', 'off_1', { sid: 2 });

    expect(native.synthesizeTts).toHaveBeenCalledWith(
      'tts_1',
      'txt_off_1',
      'off_1',
      { sid: 2 }
    );
  });

  it('stops a running call through cancelTtsGeneration and rejects as cancelled', async () => {
    const controller = new AbortController();
    native.synthesizeTts.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('TTS generation cancelled'), {
        code: 'TTS_CANCELLED',
      });
    });

    await expect(
      synthesizeTtsWithProgress(
        'tts_1',
        'txt_off_1',
        'off_1',
        { sid: 0 },
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ORCHESTRATION_CANCELLED',
    });

    const options = native.synthesizeTts.mock.calls[0]?.[3] as {
      operationId?: string;
    };
    expect(typeof options.operationId).toBe('string');
    expect(native.cancelTtsGeneration).toHaveBeenCalledWith(
      options.operationId
    );
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      synthesizeTtsWithProgress(
        'tts_1',
        'txt_off_1',
        'off_1',
        undefined,
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_CANCELLED' });
    expect(native.synthesizeTts).not.toHaveBeenCalled();
  });

  it('passes other native errors through', async () => {
    const controller = new AbortController();
    native.synthesizeTts.mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'TTS_GENERATE_ERROR' })
    );

    await expect(
      synthesizeTtsWithProgress(
        'tts_1',
        'txt_off_1',
        'off_1',
        undefined,
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'TTS_GENERATE_ERROR' });
    expect(native.cancelTtsGeneration).not.toHaveBeenCalled();
  });
});
