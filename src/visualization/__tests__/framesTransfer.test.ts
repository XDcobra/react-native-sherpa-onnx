jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
    installJSI: jest.fn(() => true),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { computeAudioVisualizationProfile } from '../index';

const mockNative = SherpaOnnx as unknown as {
  computeAudioVisualizationProfile: jest.Mock;
};

describe('visualization frames transfer', () => {
  const rounded = (values: Float32Array | number[]) =>
    Array.from(values).map((value) => Number(value.toFixed(4)));

  beforeEach(() => {
    mockNative.computeAudioVisualizationProfile.mockReset();
    delete (global as { __SherpaOnnxJSI?: unknown }).__SherpaOnnxJSI;
  });

  test('hydrates Float32Array frames via JSI transfer id', async () => {
    const transferData = new Float32Array([
      -0.1, 0.1, 0.9, 1.7, 0.3, 0.4, 0.5, 0.6,
    ]);

    (global as { __SherpaOnnxJSI?: unknown }).__SherpaOnnxJSI = {
      takeVisualizationFrames: jest.fn(() => transferData.buffer),
    };

    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 1000,
      barCount: 4,
      levels: [0.2, 0.3, 0.4, 0.5],
      frameCount: 2,
      frameDurationMs: 500,
      framesTransferId: 'viz_tx_123',
    });

    const result = await computeAudioVisualizationProfile(
      { kind: 'fs', path: '/tmp/test.wav' },
      { includeTimeline: true, frameDurationMs: 500, barCount: 4 }
    );

    expect(result.frameCount).toBe(2);
    expect(result.frameDurationMs).toBe(500);
    expect(result.frames).toBeDefined();
    expect(result.frames).toBeInstanceOf(Float32Array);
    expect(result.frames).toHaveLength(8);
    expect(rounded(result.frames ?? [])).toEqual([
      0, 0.1, 0.9, 1, 0.3, 0.4, 0.5, 0.6,
    ]);
  });

  test('pads short JSI frame payload to expected length', async () => {
    const shortData = new Float32Array([0.2, 0.3]);
    (global as { __SherpaOnnxJSI?: unknown }).__SherpaOnnxJSI = {
      takeVisualizationFrames: jest.fn(() => shortData.buffer),
    };

    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      kind: 'spectrum_bars',
      sampleRate: 16000,
      durationMs: 1000,
      barCount: 3,
      levels: [0.1, 0.2, 0.3],
      frameCount: 2,
      frameDurationMs: 500,
      framesTransferId: 'viz_tx_abc',
    });

    const result = await computeAudioVisualizationProfile(
      { kind: 'fs', path: '/tmp/test.wav' },
      { includeTimeline: true, frameDurationMs: 500, barCount: 3 }
    );

    expect(result.frames).toBeDefined();
    expect(result.frames).toHaveLength(6);
    expect(rounded(result.frames ?? [])).toEqual([0.2, 0.3, 0, 0, 0, 0]);
  });
});
