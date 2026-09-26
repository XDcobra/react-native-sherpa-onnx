jest.mock('react-native', () => {
  const mockNative = {
    createOfflineAudioBufferFromLive: jest.fn(),
    createOfflineAudioBufferFromOffline: jest.fn(),
  };

  return {
    NativeEventEmitter: class {
      addListener(): { remove: () => void } {
        return { remove: () => {} };
      }
    },
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
  };
});

import {
  createOfflineAudioBufferFromLive,
  createOfflineAudioBufferFromOffline,
} from '../index';

describe('offline resample public API', () => {
  const liveBufferId = 'live_11111111-1111-1111-1111-111111111111';
  const offlineBufferId = 'off_22222222-2222-2222-2222-222222222222';
  const reactNativeMock = jest.requireMock('react-native') as {
    __mockNative: {
      createOfflineAudioBufferFromLive: jest.Mock;
      createOfflineAudioBufferFromOffline: jest.Mock;
    };
  };
  const mockNative = reactNativeMock.__mockNative;

  beforeEach(() => {
    mockNative.createOfflineAudioBufferFromLive.mockReset();
    mockNative.createOfflineAudioBufferFromOffline.mockReset();
    mockNative.createOfflineAudioBufferFromLive.mockResolvedValue({
      bufferId: offlineBufferId,
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 48000,
      channelCount: 1,
      numSamples: 480,
      durationMs: 10,
    });
    mockNative.createOfflineAudioBufferFromOffline.mockResolvedValue({
      bufferId: 'off_33333333-3333-3333-3333-333333333333',
      kind: 'offlinePcmBuffer',
      state: 'immutable',
      sampleRate: 48000,
      channelCount: 1,
      numSamples: 480,
      durationMs: 10,
    });
  });

  it('createOfflineAudioBufferFromLive passes options object to native', async () => {
    const result = await createOfflineAudioBufferFromLive(liveBufferId, {
      mode: 'fullIfSpooled',
      targetSampleRateHz: 48000,
    });
    expect(mockNative.createOfflineAudioBufferFromLive).toHaveBeenCalledWith(
      liveBufferId,
      { mode: 'fullIfSpooled', targetSampleRateHz: 48000 }
    );
    expect(result.bufferId).toBe(offlineBufferId);
    expect(result.info.sampleRate).toBe(48000);
  });

  it('createOfflineAudioBufferFromOffline passes targetSampleRateHz', async () => {
    const result = await createOfflineAudioBufferFromOffline(offlineBufferId, {
      targetSampleRateHz: 48000,
    });
    expect(mockNative.createOfflineAudioBufferFromOffline).toHaveBeenCalledWith(
      offlineBufferId,
      { targetSampleRateHz: 48000 }
    );
    expect(result.info.sampleRate).toBe(48000);
  });
});
