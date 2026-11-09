jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
    saveAudioVisualizationProfile: jest.fn(),
    loadAudioVisualizationProfile: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  computeAudioVisualizationProfile,
  loadAudioVisualizationProfile,
  saveAudioVisualizationProfile,
} from '../index';

const mockNative = SherpaOnnx as unknown as {
  computeAudioVisualizationProfile: jest.Mock;
  saveAudioVisualizationProfile: jest.Mock;
  loadAudioVisualizationProfile: jest.Mock;
};

describe('audio visualization sidecar persist', () => {
  beforeEach(() => {
    mockNative.computeAudioVisualizationProfile.mockReset();
    mockNative.saveAudioVisualizationProfile.mockReset();
    mockNative.loadAudioVisualizationProfile.mockReset();
  });

  test('saveAudioVisualizationProfile requires destination and maps native result', async () => {
    mockNative.saveAudioVisualizationProfile.mockResolvedValue({
      format: 'sherpa_viz_v1',
      kind: 'spectrum_bars',
      barCount: 8,
      durationMs: 1000,
      sampleRate: 16000,
      hasFrames: false,
      output: { outputKind: 'fs', outputPath: '/tmp/a.wav.sviz' },
    });

    const saved = await saveAudioVisualizationProfile(
      {
        kind: 'spectrum_bars',
        sampleRate: 16000,
        durationMs: 1000,
        barCount: 8,
        levels: Array.from({ length: 8 }, () => 0.25),
        frameCount: 0,
        frameDurationMs: 0,
      },
      {
        destination: { kind: 'fs', path: '/tmp/a.wav.sviz' },
        overwrite: true,
        includeFrames: false,
      }
    );

    expect(mockNative.saveAudioVisualizationProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'spectrum_bars',
        barCount: 8,
        levels: expect.any(Array),
      }),
      expect.objectContaining({
        destination: { kind: 'fs', path: '/tmp/a.wav.sviz' },
        overwrite: true,
        includeFrames: false,
        format: 'sherpa_viz_v1',
      })
    );
    expect(saved.output).toEqual({ kind: 'fs', path: '/tmp/a.wav.sviz' });
    expect(saved.hasFrames).toBe(false);
  });

  test('loadAudioVisualizationProfile maps levels from sidecar', async () => {
    mockNative.loadAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 48000,
      durationMs: 500,
      barCount: 4,
      levels: [0.1, 0.2, 0.3, 0.4],
      frameCount: 0,
      frameDurationMs: 0,
    });

    const profile = await loadAudioVisualizationProfile({
      kind: 'fs',
      path: '/tmp/a.wav.sviz',
    });

    expect(mockNative.loadAudioVisualizationProfile).toHaveBeenCalledWith(
      { kind: 'fs', path: '/tmp/a.wav.sviz' },
      { strict: true }
    );
    expect(profile.levels).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(profile.kind).toBe('spectrum_bars');
  });

  test('compute with persist returns saved ref', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 250,
      barCount: 4,
      levels: [0.5, 0.5, 0.5, 0.5],
      frameCount: 0,
      frameDurationMs: 0,
    });
    mockNative.saveAudioVisualizationProfile.mockResolvedValue({
      format: 'sherpa_viz_v1',
      kind: 'spectrum_bars',
      barCount: 4,
      durationMs: 250,
      sampleRate: 16000,
      hasFrames: false,
      output: { outputKind: 'fs', outputPath: '/tmp/out.sviz' },
    });

    const result = await computeAudioVisualizationProfile(
      { kind: 'fs', path: '/tmp/out.wav' },
      {
        barCount: 4,
        persist: {
          destination: { kind: 'fs', path: '/tmp/out.sviz' },
          overwrite: true,
        },
      }
    );

    expect(result.levels).toHaveLength(4);
    expect(result.saved.output).toEqual({ kind: 'fs', path: '/tmp/out.sviz' });
    expect(mockNative.saveAudioVisualizationProfile).toHaveBeenCalled();
  });

  test('compute without persist does not save', async () => {
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 250,
      barCount: 4,
      levels: [0.5, 0.5, 0.5, 0.5],
      frameCount: 0,
      frameDurationMs: 0,
    });

    const result = await computeAudioVisualizationProfile({
      kind: 'fs',
      path: '/tmp/out.wav',
    });

    expect('saved' in result).toBe(false);
    expect(mockNative.saveAudioVisualizationProfile).not.toHaveBeenCalled();
  });
});
