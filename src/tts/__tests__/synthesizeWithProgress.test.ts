jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    synthesizeTts: jest.fn(),
    cancelTtsSynthesis: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { isOrchestrationCancelledError } from '../../pipeline/cancellation';
import { synthesizeTtsWithProgress } from '../synthesizeWithProgress';

describe('synthesizeTtsWithProgress cancel', () => {
  const native = SherpaOnnx as unknown as {
    synthesizeTts: jest.Mock;
    cancelTtsSynthesis: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    native.cancelTtsSynthesis.mockResolvedValue(undefined);
  });

  it('asks native to stop the running call when the signal aborts', async () => {
    const controller = new AbortController();
    let rejectNative: (err: Error) => void = () => undefined;
    native.synthesizeTts.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectNative = reject;
        })
    );

    const run = synthesizeTtsWithProgress(
      'tts_1',
      'txt_off_1',
      'off_1',
      { speed: 1 },
      undefined,
      controller.signal
    );
    controller.abort();
    rejectNative(
      Object.assign(new Error('cancelled'), { code: 'TTS_CANCELLED' })
    );

    const err = await run.catch((e: unknown) => e);
    expect(isOrchestrationCancelledError(err)).toBe(true);
    const sentOptions = native.synthesizeTts.mock.calls[0][3] as {
      operationId: string;
      speed: number;
    };
    expect(sentOptions.speed).toBe(1);
    expect(sentOptions.operationId).toMatch(/^tts_gen_/);
    expect(native.cancelTtsSynthesis).toHaveBeenCalledWith(
      sentOptions.operationId
    );
  });

  it('sends an operationId with a signal and does not cancel a finished call', async () => {
    const controller = new AbortController();
    native.synthesizeTts.mockResolvedValue(undefined);
    await synthesizeTtsWithProgress(
      'tts_1',
      'txt_off_1',
      'off_1',
      undefined,
      undefined,
      controller.signal
    );
    controller.abort();
    expect(native.synthesizeTts.mock.calls[0][3]).toHaveProperty('operationId');
    expect(native.cancelTtsSynthesis).not.toHaveBeenCalled();
  });

  it('keeps native errors when the signal did not abort', async () => {
    const controller = new AbortController();
    native.synthesizeTts.mockRejectedValue(
      Object.assign(new Error('no audio'), { code: 'TTS_EMPTY_OUTPUT' })
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
    ).rejects.toMatchObject({ code: 'TTS_EMPTY_OUTPUT' });
  });

  it('does not call native when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await synthesizeTtsWithProgress(
      'tts_1',
      'txt_off_1',
      'off_1',
      undefined,
      undefined,
      controller.signal
    ).catch((e: unknown) => e);
    expect(isOrchestrationCancelledError(err)).toBe(true);
    expect(native.synthesizeTts).not.toHaveBeenCalled();
  });

  it('keeps the plain call without progress or signal', async () => {
    native.synthesizeTts.mockResolvedValue(undefined);
    await synthesizeTtsWithProgress('tts_1', 'txt_off_1', 'off_1', {
      sid: 2,
    });
    expect(native.synthesizeTts).toHaveBeenCalledWith(
      'tts_1',
      'txt_off_1',
      'off_1',
      { sid: 2 }
    );
  });
});
