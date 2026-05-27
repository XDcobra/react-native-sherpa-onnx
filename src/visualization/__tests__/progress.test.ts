jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    computeAudioVisualizationProfile: jest.fn(),
  },
}));

type VisualizationProgressListener = (event: Record<string, unknown>) => void;

const mockAddListener = jest.fn(
  (_eventName: string, _handler: VisualizationProgressListener) => ({
    remove: jest.fn(),
  })
);

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: mockAddListener,
  })),
}));

import SherpaOnnx from '../../NativeSherpaOnnx';
import { computeAudioVisualizationProfile } from '../index';

const mockNative = SherpaOnnx as unknown as {
  computeAudioVisualizationProfile: jest.Mock;
};

describe('visualization progress', () => {
  beforeEach(() => {
    mockNative.computeAudioVisualizationProfile.mockReset();
    mockAddListener.mockClear();
    mockNative.computeAudioVisualizationProfile.mockResolvedValue({
      sampleRate: 16000,
      durationMs: 1000,
      barCount: 96,
      levels: Array.from({ length: 96 }, () => 0.1),
      frameCount: 0,
      frameDurationMs: 0,
    });
  });

  test('passes progressOperationId when onProgress is set', async () => {
    const onProgress = jest.fn();
    await computeAudioVisualizationProfile(
      { kind: 'fs', path: '/tmp/a.wav' },
      { onProgress }
    );

    expect(mockAddListener).toHaveBeenCalledWith(
      'visualizationProgress',
      expect.any(Function)
    );

    const nativeOptions =
      mockNative.computeAudioVisualizationProfile.mock.calls[0][1];
    expect(typeof nativeOptions.progressOperationId).toBe('string');
    expect(nativeOptions.progressOperationId).toMatch(/^viz_/);
    expect(nativeOptions.onProgress).toBeUndefined();
  });

  test('forwards decode and analysis events for matching operationId', async () => {
    const onProgress = jest.fn();
    const promise = computeAudioVisualizationProfile(
      { kind: 'fs', path: '/tmp/a.wav' },
      { onProgress }
    );

    expect(mockAddListener).toHaveBeenCalled();
    const [eventName, handler] = mockAddListener.mock.calls[0] as [
      string,
      VisualizationProgressListener
    ];
    expect(eventName).toBe('visualizationProgress');

    const nativeCall =
      mockNative.computeAudioVisualizationProfile.mock.calls[0]!;
    const operationId = (nativeCall[1] as { progressOperationId: string })
      .progressOperationId;

    handler({
      operationId,
      phase: 'decode',
      phasePercent: 0.5,
      framesDecoded: 1000,
      totalFramesEstimate: 2000,
    });
    handler({
      operationId: 'other',
      phase: 'decode',
      phasePercent: 1,
    });
    handler({
      operationId,
      phase: 'analysis',
      phasePercent: 0.25,
      stftWindowsDone: 256,
      stftWindowsTotal: 1024,
    });

    await promise;

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      phase: 'decode',
      phasePercent: 0.5,
      framesDecoded: 1000,
      totalFramesEstimate: 2000,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      phase: 'analysis',
      phasePercent: 0.25,
      stftWindowsDone: 256,
      stftWindowsTotal: 1024,
    });
  });

  test('does not subscribe without onProgress', async () => {
    await computeAudioVisualizationProfile({ kind: 'fs', path: '/tmp/a.wav' });
    expect(mockAddListener).not.toHaveBeenCalled();
    const nativeOptions =
      mockNative.computeAudioVisualizationProfile.mock.calls[0][1];
    expect(nativeOptions.progressOperationId).toBeUndefined();
  });
});
