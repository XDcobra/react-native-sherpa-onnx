jest.mock('react-native', () => {
  const mockNative = {
    createEmptyLiveAudioBuffer: jest.fn(),
    getPipelineAudioBufferInfo: jest.fn(),
    finalizeLiveAudioBuffer: jest.fn(),
    releasePipelineAudioBuffer: jest.fn(),
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
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  refreshLiveAudioBufferInfo,
  refreshLiveAudioBufferRef,
} from '../index';

describe('finalizeLiveAudioBuffer info', () => {
  const liveBufferId = 'live_22222222-2222-2222-2222-222222222222';
  const reactNativeMock = jest.requireMock('react-native') as {
    __mockNative: {
      createEmptyLiveAudioBuffer: jest.Mock;
      getPipelineAudioBufferInfo: jest.Mock;
      finalizeLiveAudioBuffer: jest.Mock;
    };
  };
  const mockNative = reactNativeMock.__mockNative;

  const recordingInfo = {
    bufferId: liveBufferId,
    kind: 'livePcmBuffer' as const,
    state: 'recording' as const,
    sampleRate: 16000,
    channelCount: 1,
    numSamples: 0,
    durationMs: 0,
    totalSamplesWritten: 0,
    ringEvictedSamples: 0,
    hasActiveSpool: true,
  };

  const finishedInfo = {
    ...recordingInfo,
    state: 'finished' as const,
    numSamples: 48000,
    durationMs: 3000,
    totalSamplesWritten: 48000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.createEmptyLiveAudioBuffer.mockResolvedValue(recordingInfo);
    mockNative.finalizeLiveAudioBuffer.mockResolvedValue(null);
    mockNative.getPipelineAudioBufferInfo.mockResolvedValue(finishedInfo);
  });

  it('returns fresh finished info after native finalize', async () => {
    const ref = await createEmptyLiveAudioBuffer({ sampleRate: 16000 });
    expect(ref.info.durationMs).toBe(0);

    const finished = await finalizeLiveAudioBuffer(ref);

    expect(mockNative.finalizeLiveAudioBuffer).toHaveBeenCalledWith(
      liveBufferId
    );
    expect(mockNative.getPipelineAudioBufferInfo).toHaveBeenCalledWith(
      liveBufferId
    );
    expect(finished.bufferId).toBe(liveBufferId);
    expect(finished.info.state).toBe('finished');
    expect(finished.info.durationMs).toBe(3000);
    expect(finished.info.numSamples).toBe(48000);
  });

  it('refreshLiveAudioBufferInfo returns live info from native', async () => {
    const ref = await createEmptyLiveAudioBuffer({ sampleRate: 16000 });
    mockNative.getPipelineAudioBufferInfo.mockResolvedValue({
      ...recordingInfo,
      numSamples: 8000,
      durationMs: 500,
      totalSamplesWritten: 8000,
    });

    const info = await refreshLiveAudioBufferInfo(ref);
    expect(info.durationMs).toBe(500);
    expect(info.state).toBe('recording');
  });

  it('refreshLiveAudioBufferRef merges info into ref', async () => {
    const ref = await createEmptyLiveAudioBuffer({ sampleRate: 16000 });
    mockNative.getPipelineAudioBufferInfo.mockResolvedValue({
      ...recordingInfo,
      durationMs: 750,
      totalSamplesWritten: 12000,
    });

    const updated = await refreshLiveAudioBufferRef(ref);
    expect(updated.info.durationMs).toBe(750);
    expect(updated.bufferId).toBe(ref.bufferId);
    expect(ref.info.durationMs).toBe(0);
  });
});
