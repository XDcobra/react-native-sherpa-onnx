jest.mock('react-native', () => {
  const mockNative = {
    appendLiveSegment: jest.fn().mockResolvedValue({
      segmentId: 'seg_1',
      segmentIndex: 0,
    }),
  };

  return {
    NativeEventEmitter: class {
      addListener() {
        return { remove: () => undefined };
      }
    },
    TurboModuleRegistry: {
      getEnforcing: jest.fn(() => mockNative),
    },
    __segmentbufferMockNative: mockNative,
  };
});

import { appendLiveSegment } from '../index';

const reactNativeModule = jest.requireMock('react-native') as {
  __segmentbufferMockNative: {
    appendLiveSegment: jest.Mock;
  };
};

const LIVE_SEG_ID = 'seg_live_123e4567-e89b-12d3-a456-426614174000';
const AUDIO_ID = 'off_123e4567-e89b-12d3-a456-426614174000';

describe('segmentbuffer speech payload source pyannote', () => {
  beforeEach(() => {
    reactNativeModule.__segmentbufferMockNative.appendLiveSegment.mockClear();
  });

  test('accepts pyannote source-only payload', async () => {
    await appendLiveSegment(LIVE_SEG_ID, {
      kind: 'speech',
      sourceAudioBufferId: AUDIO_ID,
      startSample: 0,
      endSample: 1600,
      sampleRate: 16000,
      payload: { source: 'pyannote' },
    });

    expect(
      reactNativeModule.__segmentbufferMockNative.appendLiveSegment
    ).toHaveBeenCalledWith(
      LIVE_SEG_ID,
      'speech',
      AUDIO_ID,
      0,
      1600,
      16000,
      undefined,
      undefined,
      { source: 'pyannote' }
    );
  });

  test('rejects unknown keys on pyannote payload', async () => {
    await expect(
      appendLiveSegment(LIVE_SEG_ID, {
        kind: 'speech',
        sourceAudioBufferId: AUDIO_ID,
        startSample: 0,
        endSample: 1600,
        sampleRate: 16000,
        payload: {
          source: 'pyannote',
          hasOverlap: true,
        } as any,
      })
    ).rejects.toThrow(/hasOverlap is not allowed/);
  });
});
