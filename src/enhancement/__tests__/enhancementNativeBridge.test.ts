import { buildEnhancementInitBridgeOptions } from '../enhancementNativeBridge';
import { resolveEnhancementCustomConfigPaths } from '../customConfig';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/gtcrn'),
}));

jest.mock('../customConfig', () => ({
  resolveEnhancementCustomConfigPaths: jest.fn(async () => ({
    model: '/models/gtcrn.onnx',
  })),
}));

const mockResolveCustomPaths = resolveEnhancementCustomConfigPaths as jest.Mock;

describe('enhancementNativeBridge', () => {
  it('buildEnhancementInitBridgeOptions maps auto options to bridge map', async () => {
    const bridge = await buildEnhancementInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/gtcrn' },
      modelType: 'gtcrn',
      numThreads: 2,
      debug: false,
    });
    expect(bridge).toEqual({
      initMode: 'auto',
      modelDir: '/models/gtcrn',
      modelType: 'gtcrn',
      numThreads: 2,
      debug: false,
    });
  });

  it('buildEnhancementInitBridgeOptions maps custom options to modelPaths', async () => {
    const bridge = await buildEnhancementInitBridgeOptions({
      initMode: 'custom',
      modelType: 'gtcrn',
      customConfig: {
        model: { kind: 'fs', path: '/models/gtcrn.onnx' },
      },
    });
    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelPaths).toEqual({ model: '/models/gtcrn.onnx' });
    expect(bridge.modelType).toBe('gtcrn');
  });

  it('maps custom VoxLock options to enrollModel and chunkModel', async () => {
    mockResolveCustomPaths.mockResolvedValueOnce({
      enrollModel: '/models/voxlock_enroll.onnx',
      chunkModel: '/models/voxlock_chunk.onnx',
    });

    const bridge = await buildEnhancementInitBridgeOptions({
      initMode: 'custom',
      modelType: 'voxlock',
      customConfig: {
        enrollModel: { kind: 'fs', path: '/models/voxlock_enroll.onnx' },
        chunkModel: { kind: 'fs', path: '/models/voxlock_chunk.onnx' },
      },
    });

    expect(bridge.initMode).toBe('custom');
    expect(bridge.modelDir).toBeUndefined();
    expect(bridge.modelType).toBe('voxlock');
    expect(bridge.modelPaths).toEqual({
      enrollModel: '/models/voxlock_enroll.onnx',
      chunkModel: '/models/voxlock_chunk.onnx',
    });
  });
});
