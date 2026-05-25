jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import type { LiveBufferHandleFinished } from '../../audiobuffer/types';
import { computeAudioVisualizationProfile } from '../index';

const mockNative = SherpaOnnx as unknown as {
  computeAudioVisualizationProfile: jest.Mock;
};

describe('computeAudioVisualizationProfile', () => {
  const offId = 'off_123e4567-e89b-12d3-a456-426614174000';
  const liveId = 'live_123e4567-e89b-12d3-a456-426614174111';

  beforeEach(() => {
    mockNative.computeAudioVisualizationProfile.mockReset();
  });

  test('maps FileSource input and default options', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 1234,
      barCount: 96,
      levels: Array.from({ length: 96 }, () => 0.5),
    });

    const source = { kind: 'fs', path: '/tmp/file.wav' } as const;
    const result = await computeAudioVisualizationProfile(source);

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      {
        kind: 'file',
        source,
      },
      {
        kind: 'spectrum_bars',
        barCount: 96,
        minHz: 60,
        maxHz: 0,
        timeAggregate: 'max_hold',
        includeTimeline: false,
        maxAnalysisDurationMs: 0,
      }
    );

    expect(result.barCount).toBe(96);
    expect(result.levels).toHaveLength(96);
    expect(result.kind).toBe('spectrum_bars');
  });

  test('maps offline buffer input', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 48000,
      durationMs: 500,
      barCount: 32,
      levels: Array.from({ length: 32 }, (_, i) => i / 32),
    });

    await computeAudioVisualizationProfile(offId, {
      barCount: 32,
      minHz: 80,
      maxHz: 12000,
      timeAggregate: 'max_hold',
    });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      {
        kind: 'offline',
        bufferId: offId,
      },
      {
        kind: 'spectrum_bars',
        barCount: 32,
        minHz: 80,
        maxHz: 12000,
        timeAggregate: 'max_hold',
        includeTimeline: false,
        maxAnalysisDurationMs: 0,
      }
    );
  });

  test('maps live input and clamps native levels to 0..1', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 42,
      barCount: 5,
      levels: [1.4, -0.5, 0.2],
    });

    const result = await computeAudioVisualizationProfile({
      kind: 'live',
      handle: liveId as LiveBufferHandleFinished,
    });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      {
        kind: 'live',
        handle: liveId,
      },
      {
        kind: 'spectrum_bars',
        barCount: 96,
        minHz: 60,
        maxHz: 0,
        timeAggregate: 'max_hold',
        includeTimeline: false,
        maxAnalysisDurationMs: 0,
      }
    );

    expect(result.levels).toEqual([1, 0, 0.2, 0, 0]);
  });

  test('accepts mean time aggregate for global levels', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 320,
      barCount: 16,
      levels: Array.from({ length: 16 }, () => 0.2),
      frameCount: 0,
      frameDurationMs: 0,
    });

    await computeAudioVisualizationProfile(offId, {
      timeAggregate: 'mean',
    });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      {
        kind: 'offline',
        bufferId: offId,
      },
      {
        kind: 'spectrum_bars',
        barCount: 96,
        minHz: 60,
        maxHz: 0,
        timeAggregate: 'mean',
        includeTimeline: false,
        maxAnalysisDurationMs: 0,
      }
    );
  });
});
