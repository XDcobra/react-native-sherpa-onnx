jest.mock('../../detect/customConfigResolver', () => ({
  assertCustomModelConfig: jest.fn(),
  resolveCustomModelConfigPaths: jest.fn(async () => ({
    det: '/m/det.onnx',
    rec: '/m/rec.onnx',
    rec_dict: '/m/rec_inference.yml',
  })),
}));

jest.mock('../ocrNativeBridge', () => {
  const actual = jest.requireActual('../ocrNativeBridge');
  return actual;
});

import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import { resolveCustomModelConfigPaths } from '../../detect/customConfigResolver';
import { resolveOcrCustomConfigPaths } from '../customConfig';
import { buildOcrInitBridgeOptions } from '../ocrNativeBridge';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveFileSourceForModelInit: jest.fn(async () => '/models/ppocrv6-tiny'),
}));

const mockResolvePaths = resolveCustomModelConfigPaths as jest.Mock;
const mockResolveDir = resolveFileSourceForModelInit as jest.Mock;

describe('OCR customConfig / bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvePaths.mockResolvedValue({
      det: '/m/det.onnx',
      rec: '/m/rec.onnx',
      rec_dict: '/m/rec_inference.yml',
    });
    mockResolveDir.mockResolvedValue('/models/ppocrv6-tiny');
  });

  it('resolveOcrCustomConfigPaths forwards category ocr', async () => {
    await resolveOcrCustomConfigPaths('ppocr', {
      det: { kind: 'fs', path: '/m/det.onnx' },
      rec: { kind: 'fs', path: '/m/rec.onnx' },
      rec_dict: { kind: 'fs', path: '/m/rec_inference.yml' },
    });
    expect(mockResolvePaths).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ocr',
        modelType: 'ppocr',
      })
    );
  });

  it('buildOcrInitBridgeOptions auto uses modelDir', async () => {
    const bridge = await buildOcrInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/ppocrv6-tiny' },
      modelType: 'auto',
    });
    expect(bridge).toEqual(
      expect.objectContaining({
        initMode: 'auto',
        modelDir: '/models/ppocrv6-tiny',
        modelType: 'auto',
      })
    );
    expect(bridge.modelPaths).toBeUndefined();
  });

  it('buildOcrInitBridgeOptions auto forwards quantization', async () => {
    const bridge = await buildOcrInitBridgeOptions({
      modelSource: { kind: 'fs', path: '/models/docvlm-granite-258m-q8' },
      modelType: 'doc_vlm',
      quantization: 'q8',
    });
    expect(bridge).toEqual(
      expect.objectContaining({
        initMode: 'auto',
        modelType: 'doc_vlm',
        quantization: 'q8',
      })
    );
  });

  it('buildOcrInitBridgeOptions custom uses modelPaths', async () => {
    const bridge = await buildOcrInitBridgeOptions({
      initMode: 'custom',
      modelType: 'ppocr',
      customConfig: {
        det: { kind: 'fs', path: '/m/det.onnx' },
        rec: { kind: 'fs', path: '/m/rec.onnx' },
        rec_dict: { kind: 'fs', path: '/m/rec_inference.yml' },
      },
    });
    expect(bridge).toEqual(
      expect.objectContaining({
        initMode: 'custom',
        modelType: 'ppocr',
        modelPaths: {
          det: '/m/det.onnx',
          rec: '/m/rec.onnx',
          rec_dict: '/m/rec_inference.yml',
        },
      })
    );
    expect(bridge.modelDir).toBeUndefined();
  });
});
