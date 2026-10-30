jest.mock('react-native', () => {
  const mockNative = {
    getOfflineTextBufferTextSlice: jest.fn(),
    getOfflineTextBufferTokensSlice: jest.fn(),
    getOfflineTextBufferTimestampsSlice: jest.fn(),
    getOfflineTextBufferDurationsSlice: jest.fn(),
    getOfflineTextBufferSpatialSpansSlice: jest.fn(),
  };

  return {
    NativeEventEmitter: jest.fn(),
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __mockNative: mockNative,
  };
});

import {
  getOfflineTextBufferDurationsSlice,
  getOfflineTextBufferSpatialSpansSlice,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferTokensSlice,
} from '../index';
import { TEXT_MAX_SLICE_COUNT } from '../types';

describe('offline textbuffer slice chunking', () => {
  const reactNativeMock = jest.requireMock('react-native') as {
    __mockNative: {
      getOfflineTextBufferTextSlice: jest.Mock;
      getOfflineTextBufferTokensSlice: jest.Mock;
      getOfflineTextBufferTimestampsSlice: jest.Mock;
      getOfflineTextBufferDurationsSlice: jest.Mock;
      getOfflineTextBufferSpatialSpansSlice: jest.Mock;
    };
  };
  const mockNative = reactNativeMock.__mockNative;

  const bufferId = 'txt_off_11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses one native call when maxUtf16 is within cap', async () => {
    mockNative.getOfflineTextBufferTextSlice.mockResolvedValue('abc');
    const out = await getOfflineTextBufferTextSlice(bufferId, 0, 100);
    expect(out).toBe('abc');
    expect(mockNative.getOfflineTextBufferTextSlice).toHaveBeenCalledTimes(1);
    expect(mockNative.getOfflineTextBufferTextSlice).toHaveBeenCalledWith(
      bufferId,
      0,
      100
    );
  });

  it('chunks text reads across the native UTF-16 cap', async () => {
    const cap = TEXT_MAX_SLICE_COUNT;
    const chunkA = 'a'.repeat(cap);
    const chunkB = 'b'.repeat(500);
    mockNative.getOfflineTextBufferTextSlice
      .mockResolvedValueOnce(chunkA)
      .mockResolvedValueOnce(chunkB);

    const out = await getOfflineTextBufferTextSlice(bufferId, 0, cap + 500);
    expect(out).toBe(chunkA + chunkB);
    expect(mockNative.getOfflineTextBufferTextSlice).toHaveBeenCalledTimes(2);
    expect(mockNative.getOfflineTextBufferTextSlice).toHaveBeenNthCalledWith(
      1,
      bufferId,
      0,
      cap
    );
    expect(mockNative.getOfflineTextBufferTextSlice).toHaveBeenNthCalledWith(
      2,
      bufferId,
      cap,
      500
    );
  });

  it('chunks token array reads', async () => {
    const cap = TEXT_MAX_SLICE_COUNT;
    const first = Array.from({ length: cap }, (_, i) => `t${i}`);
    const second = ['x', 'y'];
    mockNative.getOfflineTextBufferTokensSlice
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const out = await getOfflineTextBufferTokensSlice(bufferId, 0, cap + 2);
    expect(out).toEqual([...first, ...second]);
    expect(mockNative.getOfflineTextBufferTokensSlice).toHaveBeenCalledTimes(2);
  });

  it('chunks timestamp array reads', async () => {
    const cap = TEXT_MAX_SLICE_COUNT;
    const first = Array.from({ length: cap }, (_, i) => i);
    const second = [9, 8];
    mockNative.getOfflineTextBufferTimestampsSlice
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const out = await getOfflineTextBufferTimestampsSlice(bufferId, 0, cap + 2);
    expect(out).toEqual([...first, ...second]);
  });

  it('chunks duration array reads', async () => {
    const cap = TEXT_MAX_SLICE_COUNT;
    const first = Array.from({ length: cap }, (_, i) => i * 0.1);
    const second = [0.5];
    mockNative.getOfflineTextBufferDurationsSlice
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const out = await getOfflineTextBufferDurationsSlice(bufferId, 0, cap + 1);
    expect(out).toEqual([...first, ...second]);
  });

  it('chunks spatial span object-array reads and maps fields', async () => {
    const cap = TEXT_MAX_SLICE_COUNT;
    const makeSpan = (i: number) => ({
      utf16Start: i,
      utf16End: i + 1,
      level: 'line',
      sourceImageBufferId: 'img_off_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      frameIndex: 0,
      quad: [0, 0, 1, 0, 1, 1, 0, 1],
      origin: 'ocr',
      confidence: 0.9,
    });
    const first = Array.from({ length: cap }, (_, i) => makeSpan(i));
    const second = [makeSpan(cap)];
    mockNative.getOfflineTextBufferSpatialSpansSlice
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const out = await getOfflineTextBufferSpatialSpansSlice(
      bufferId,
      0,
      cap + 1
    );
    expect(out).toHaveLength(cap + 1);
    expect(out[0]).toMatchObject({
      utf16Start: 0,
      utf16End: 1,
      level: 'line',
      origin: 'ocr',
      confidence: 0.9,
      quad: [0, 0, 1, 0, 1, 1, 0, 1],
    });
    expect(out[cap]?.utf16Start).toBe(cap);
    expect(
      mockNative.getOfflineTextBufferSpatialSpansSlice
    ).toHaveBeenCalledTimes(2);
  });

  it('uses one native call for spatial spans within cap', async () => {
    mockNative.getOfflineTextBufferSpatialSpansSlice.mockResolvedValue([]);
    const out = await getOfflineTextBufferSpatialSpansSlice(bufferId, 0, 10);
    expect(out).toEqual([]);
    expect(
      mockNative.getOfflineTextBufferSpatialSpansSlice
    ).toHaveBeenCalledTimes(1);
    expect(
      mockNative.getOfflineTextBufferSpatialSpansSlice
    ).toHaveBeenCalledWith(bufferId, 0, 10);
  });

  it('maps textLayer spans without image id and with page size', async () => {
    mockNative.getOfflineTextBufferSpatialSpansSlice.mockResolvedValue([
      {
        utf16Start: 0,
        utf16End: 4,
        level: 'line',
        sourceImageBufferId: '',
        frameIndex: 0,
        quad: [10, 20, 110, 20, 110, 40, 10, 40],
        origin: 'textLayer',
        pageNumber: 1,
        pageWidth: 612,
        pageHeight: 792,
      },
    ]);
    const out = await getOfflineTextBufferSpatialSpansSlice(bufferId, 0, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      origin: 'textLayer',
      pageNumber: 1,
      pageWidth: 612,
      pageHeight: 792,
      quad: [10, 20, 110, 20, 110, 40, 10, 40],
    });
    expect(out[0]?.sourceImageBufferId).toBeUndefined();
  });
});
