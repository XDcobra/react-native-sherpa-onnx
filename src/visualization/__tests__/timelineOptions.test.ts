jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { computeAudioVisualizationProfile } from '../index';

const mockNative = SherpaOnnx as unknown as {
  computeAudioVisualizationProfile: jest.Mock;
};

describe('visualization timeline option resolution', () => {
  const source = { kind: 'fs', path: '/tmp/in.wav' } as const;

  beforeEach(() => {
    mockNative.computeAudioVisualizationProfile.mockReset();
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 1000,
      barCount: 96,
      levels: Array.from({ length: 96 }, () => 0.1),
      frameCount: 0,
      frameDurationMs: 0,
    });
  });

  test('disables timeline by default', async () => {
    await computeAudioVisualizationProfile(source);

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      { kind: 'file', source },
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
  });

  test('uses default timeline duration when includeTimeline=true', async () => {
    await computeAudioVisualizationProfile(source, { includeTimeline: true });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      { kind: 'file', source },
      expect.objectContaining({
        includeTimeline: true,
        frameDurationMs: 500,
      })
    );
    expect(
      mockNative.computeAudioVisualizationProfile.mock.calls[0][1]
    ).not.toHaveProperty('frameCount');
  });

  test('frameCount has priority when both frameCount and frameDurationMs are set', async () => {
    await computeAudioVisualizationProfile(source, {
      frameCount: 24,
      frameDurationMs: 120,
      includeTimeline: true,
    });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      { kind: 'file', source },
      expect.objectContaining({
        includeTimeline: true,
        frameCount: 24,
        frameDurationMs: 0,
      })
    );
  });

  test('uses frameDurationMs when provided alone', async () => {
    await computeAudioVisualizationProfile(source, {
      frameDurationMs: 250,
    });

    expect(mockNative.computeAudioVisualizationProfile).toHaveBeenCalledWith(
      { kind: 'file', source },
      expect.objectContaining({
        includeTimeline: true,
        frameDurationMs: 250,
      })
    );
  });

  test('rejects frameCount outside native limits', async () => {
    await expect(
      computeAudioVisualizationProfile(source, { frameCount: 7 })
    ).rejects.toThrow('AUDIO_VISUALIZATION_INVALID_OPTIONS');
  });
});
