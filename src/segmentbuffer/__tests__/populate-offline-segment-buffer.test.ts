jest.mock('react-native', () => {
  const mockNative = {
    populateOfflineSegmentBufferIfEmpty: jest.fn().mockResolvedValue(undefined),
  };

  return {
    TurboModuleRegistry: {
      getEnforcing: jest.fn(() => mockNative),
    },
    __segmentbufferMockNative: mockNative,
  };
});

import {
  populateOfflineSegmentBufferIfEmpty,
  createOfflineSegmentBufferFromLive,
} from '../index';

const reactNativeModule = jest.requireMock('react-native') as {
  __segmentbufferMockNative: {
    populateOfflineSegmentBufferIfEmpty: jest.Mock;
  };
};

const OFFLINE_SEG_ID = 'seg_off_123e4567-e89b-12d3-a456-426614174000';
const LIVE_SEG_ID = 'seg_live_123e4567-e89b-12d3-a456-426614174000';

describe('segmentbuffer/populateOfflineSegmentBufferIfEmpty', () => {
  beforeEach(() => {
    reactNativeModule.__segmentbufferMockNative.populateOfflineSegmentBufferIfEmpty.mockClear();
  });

  test('forwards typed ids and mode to native', async () => {
    await populateOfflineSegmentBufferIfEmpty(
      OFFLINE_SEG_ID,
      LIVE_SEG_ID,
      'windowSnapshot'
    );

    expect(
      reactNativeModule.__segmentbufferMockNative
        .populateOfflineSegmentBufferIfEmpty
    ).toHaveBeenCalledWith(OFFLINE_SEG_ID, LIVE_SEG_ID, 'windowSnapshot');
  });

  test('defaults mode to fullIfSpooled', async () => {
    await populateOfflineSegmentBufferIfEmpty(OFFLINE_SEG_ID, LIVE_SEG_ID);

    expect(
      reactNativeModule.__segmentbufferMockNative
        .populateOfflineSegmentBufferIfEmpty
    ).toHaveBeenCalledWith(OFFLINE_SEG_ID, LIVE_SEG_ID, 'fullIfSpooled');
  });

  test('rejects invalid target buffer id before native call', async () => {
    await expect(
      populateOfflineSegmentBufferIfEmpty('seg_live_invalid', LIVE_SEG_ID)
    ).rejects.toThrow('SEGMENT_INVALID_ARGUMENT');

    expect(
      reactNativeModule.__segmentbufferMockNative
        .populateOfflineSegmentBufferIfEmpty
    ).not.toHaveBeenCalled();
  });

  test('createOfflineSegmentBufferFromLive no longer accepts intoExisting strings', async () => {
    await expect(
      createOfflineSegmentBufferFromLive(LIVE_SEG_ID, 'intoExisting:foo' as any)
    ).rejects.toThrow('SEGMENT_INVALID_ARGUMENT');
  });
});
