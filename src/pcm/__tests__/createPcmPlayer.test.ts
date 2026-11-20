jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    createPcmPlayer: jest.fn(),
    resumePcmPlayer: jest.fn(),
    destroyPcmPlayer: jest.fn(),
  },
}));

jest.mock('../../audiobuffer/index', () => ({
  resolvePipelineAudioBufferId: jest.fn((buffer: unknown) =>
    typeof buffer === 'string' ? buffer : (buffer as { id: string }).id
  ),
}));

const mockRemove = jest.fn();
const mockAddListener = jest.fn(
  (_eventName: string, _handler: (event: unknown) => void) => ({
    remove: mockRemove,
  })
);

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: mockAddListener,
  })),
  NativeModules: {
    SherpaOnnx: {},
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { createPcmPlayer } from '../index';

const mockNative = SherpaOnnx as unknown as {
  createPcmPlayer: jest.Mock;
  resumePcmPlayer: jest.Mock;
  destroyPcmPlayer: jest.Mock;
};

const BUFFER_ID = 'off_00000000-0000-0000-0000-000000000001';

describe('createPcmPlayer start options', () => {
  beforeEach(() => {
    mockNative.createPcmPlayer.mockReset().mockResolvedValue(undefined);
    mockNative.resumePcmPlayer.mockReset().mockResolvedValue(undefined);
    mockNative.destroyPcmPlayer.mockReset().mockResolvedValue(undefined);
    mockAddListener.mockClear();
    mockRemove.mockClear();
  });

  test('defaults: no start position (-1) and autoplay on', async () => {
    const player = await createPcmPlayer(BUFFER_ID);
    expect(mockNative.createPcmPlayer).toHaveBeenCalledWith(
      player.playerId,
      BUFFER_ID,
      1.0,
      -1,
      true
    );
  });

  test('passes startMs and autoplay: false to native', async () => {
    const player = await createPcmPlayer(BUFFER_ID, {
      volume: 0.5,
      startMs: 1250,
      autoplay: false,
    });
    expect(mockNative.createPcmPlayer).toHaveBeenCalledWith(
      player.playerId,
      BUFFER_ID,
      0.5,
      1250,
      false
    );

    await player.resume();
    expect(mockNative.resumePcmPlayer).toHaveBeenCalledWith(player.playerId);
  });

  test('startMs: 0 is passed as an explicit start position', async () => {
    await createPcmPlayer(BUFFER_ID, { startMs: 0 });
    const args = mockNative.createPcmPlayer.mock.calls[0];
    expect(args[3]).toBe(0);
    expect(args[4]).toBe(true);
  });

  test('autoplay: true with startMs keeps autoplay on', async () => {
    await createPcmPlayer(BUFFER_ID, { startMs: 500, autoplay: true });
    const args = mockNative.createPcmPlayer.mock.calls[0];
    expect(args[3]).toBe(500);
    expect(args[4]).toBe(true);
  });

  test.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '100' as unknown as number],
  ])('rejects startMs that is %s', async (_label, startMs) => {
    await expect(
      createPcmPlayer(BUFFER_ID, {
        startMs,
        onEnded: jest.fn(),
        onPosition: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'PCM_PLAYER_INVALID_CONFIG' });
    expect(mockNative.createPcmPlayer).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  test('rejects a non-boolean autoplay', async () => {
    await expect(
      createPcmPlayer(BUFFER_ID, {
        autoplay: 'no' as unknown as boolean,
        onEnded: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'PCM_PLAYER_INVALID_CONFIG' });
    expect(mockNative.createPcmPlayer).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  test('subscribes listeners before native create and removes them when it fails', async () => {
    mockNative.createPcmPlayer.mockImplementation(async () => {
      expect(mockAddListener).toHaveBeenCalledTimes(2);
      throw Object.assign(new Error('boom'), { code: 'PCM_PLAYER_ERROR' });
    });
    await expect(
      createPcmPlayer(BUFFER_ID, {
        startMs: 2000,
        autoplay: false,
        onEnded: jest.fn(),
        onPosition: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'PCM_PLAYER_ERROR' });
    expect(mockRemove).toHaveBeenCalledTimes(2);
  });

  test('onPosition forwards the native position for its own player only', async () => {
    const onPosition = jest.fn();
    const player = await createPcmPlayer(BUFFER_ID, {
      startMs: 3000,
      onPosition,
    });
    const positionCall = mockAddListener.mock.calls.find(
      ([name]) => name === 'pcmPlayerPosition'
    );
    expect(positionCall).toBeDefined();
    const handler = positionCall![1];
    handler({ playerId: 'other', bufferId: BUFFER_ID, positionMs: 0 });
    handler({
      playerId: player.playerId,
      bufferId: BUFFER_ID,
      positionMs: 3000,
    });
    expect(onPosition).toHaveBeenCalledTimes(1);
    expect(onPosition).toHaveBeenCalledWith({
      playerId: player.playerId,
      bufferId: BUFFER_ID,
      positionMs: 3000,
    });
  });
});
