jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
    installJSI: jest.fn(() => true),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { takeVisualizationFrames } from '../jsi';

describe('visualization native spec shape', () => {
  beforeEach(() => {
    delete (global as { __SherpaOnnxJSI?: unknown }).__SherpaOnnxJSI;
  });

  test('exposes computeAudioVisualizationProfile', () => {
    const native = SherpaOnnx as unknown as {
      computeAudioVisualizationProfile?: unknown;
      installJSI?: unknown;
    };

    expect(typeof native.computeAudioVisualizationProfile).toBe('function');
    expect(typeof native.installJSI).toBe('function');
  });

  test('uses JSI takeVisualizationFrames when installed', () => {
    const bytes = new Float32Array([0.1, 0.2, 0.3]).buffer;
    (global as { __SherpaOnnxJSI?: unknown }).__SherpaOnnxJSI = {
      takeVisualizationFrames: jest.fn(() => bytes),
    };

    const buffer = takeVisualizationFrames('viz_tx_123');
    expect(buffer).toBe(bytes);
  });
});
