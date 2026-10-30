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

  it('resolveOcrCustomConfigPaths forwards nemotron_parse', async () => {
    mockResolvePaths.mockResolvedValue({
      vision_encoder: '/m/vision_encoder.onnx',
      vision_encoder_data: '/m/vision_encoder.onnx_data',
      embed_tokens: '/m/embed_tokens.onnx',
      embed_tokens_data: '/m/embed_tokens.onnx_data',
      decoder: '/m/decoder_model_merged.onnx',
      decoder_data: '/m/decoder_model_merged.onnx_data',
      tokenizer: '/m/tokenizer.json',
      manifest: '/m/ocr_manifest.json',
      patch_embed: '/m/patch_embed.onnx',
      pos_embed: '/m/pos_embed.npy',
    });
    await resolveOcrCustomConfigPaths('nemotron_parse', {
      vision_encoder: { kind: 'fs', path: '/m/vision_encoder.onnx' },
      vision_encoder_data: { kind: 'fs', path: '/m/vision_encoder.onnx_data' },
      embed_tokens: { kind: 'fs', path: '/m/embed_tokens.onnx' },
      embed_tokens_data: { kind: 'fs', path: '/m/embed_tokens.onnx_data' },
      decoder: { kind: 'fs', path: '/m/decoder_model_merged.onnx' },
      decoder_data: { kind: 'fs', path: '/m/decoder_model_merged.onnx_data' },
      tokenizer: { kind: 'fs', path: '/m/tokenizer.json' },
      manifest: { kind: 'fs', path: '/m/ocr_manifest.json' },
      patch_embed: { kind: 'fs', path: '/m/patch_embed.onnx' },
      pos_embed: { kind: 'fs', path: '/m/pos_embed.npy' },
    });
    expect(mockResolvePaths).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ocr',
        modelType: 'nemotron_parse',
      })
    );
  });

  it('buildOcrInitBridgeOptions custom uses nemotron_parse paths + maxNewTokens', async () => {
    mockResolvePaths.mockResolvedValue({
      vision_encoder: '/m/vision_encoder.onnx',
      vision_encoder_data: '/m/vision_encoder.onnx_data',
      embed_tokens: '/m/embed_tokens.onnx',
      embed_tokens_data: '/m/embed_tokens.onnx_data',
      decoder: '/m/decoder_model_merged.onnx',
      decoder_data: '/m/decoder_model_merged.onnx_data',
      tokenizer: '/m/tokenizer.json',
      manifest: '/m/ocr_manifest.json',
      patch_embed: '/m/patch_embed.onnx',
      patch_embed_data: '/m/patch_embed.onnx_data',
      pos_embed: '/m/pos_embed.npy',
    });
    const bridge = await buildOcrInitBridgeOptions({
      initMode: 'custom',
      modelType: 'nemotron_parse',
      maxNewTokens: 512,
      customConfig: {
        vision_encoder: { kind: 'fs', path: '/m/vision_encoder.onnx' },
        vision_encoder_data: {
          kind: 'fs',
          path: '/m/vision_encoder.onnx_data',
        },
        embed_tokens: { kind: 'fs', path: '/m/embed_tokens.onnx' },
        embed_tokens_data: { kind: 'fs', path: '/m/embed_tokens.onnx_data' },
        decoder: { kind: 'fs', path: '/m/decoder_model_merged.onnx' },
        decoder_data: { kind: 'fs', path: '/m/decoder_model_merged.onnx_data' },
        tokenizer: { kind: 'fs', path: '/m/tokenizer.json' },
        manifest: { kind: 'fs', path: '/m/ocr_manifest.json' },
        patch_embed: { kind: 'fs', path: '/m/patch_embed.onnx' },
        patch_embed_data: { kind: 'fs', path: '/m/patch_embed.onnx_data' },
        pos_embed: { kind: 'fs', path: '/m/pos_embed.npy' },
      },
    });
    expect(bridge).toEqual(
      expect.objectContaining({
        initMode: 'custom',
        modelType: 'nemotron_parse',
        maxNewTokens: 512,
        modelPaths: {
          vision_encoder: '/m/vision_encoder.onnx',
          vision_encoder_data: '/m/vision_encoder.onnx_data',
          embed_tokens: '/m/embed_tokens.onnx',
          embed_tokens_data: '/m/embed_tokens.onnx_data',
          decoder: '/m/decoder_model_merged.onnx',
          decoder_data: '/m/decoder_model_merged.onnx_data',
          tokenizer: '/m/tokenizer.json',
          manifest: '/m/ocr_manifest.json',
          patch_embed: '/m/patch_embed.onnx',
          patch_embed_data: '/m/patch_embed.onnx_data',
          pos_embed: '/m/pos_embed.npy',
        },
      })
    );
    expect(bridge.modelDir).toBeUndefined();
  });

  it('resolveOcrCustomConfigPaths forwards paddleocr_vl', async () => {
    mockResolvePaths.mockResolvedValue({
      vision_encoder: '/m/vision_encoder.onnx',
      embedding: '/m/embedding.onnx',
      decoder: '/m/decoder.onnx',
      tokenizer: '/m/tokenizer.json',
    });
    await resolveOcrCustomConfigPaths('paddleocr_vl', {
      vision_encoder: { kind: 'fs', path: '/m/vision_encoder.onnx' },
      embedding: { kind: 'fs', path: '/m/embedding.onnx' },
      decoder: { kind: 'fs', path: '/m/decoder.onnx' },
      tokenizer: { kind: 'fs', path: '/m/tokenizer.json' },
    });
    expect(mockResolvePaths).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ocr',
        modelType: 'paddleocr_vl',
      })
    );
  });

  it('buildOcrInitBridgeOptions custom uses paddleocr_vl paths + maxNewTokens', async () => {
    mockResolvePaths.mockResolvedValue({
      vision_encoder: '/m/vision_encoder.onnx',
      vision_encoder_data: '/m/vision_encoder.onnx_data',
      embedding: '/m/embedding.onnx',
      embedding_data: '/m/embedding.onnx_data',
      decoder: '/m/decoder.onnx',
      decoder_data: '/m/decoder.onnx_data',
      tokenizer: '/m/tokenizer.json',
      manifest: '/m/ocr_manifest.json',
    });
    const bridge = await buildOcrInitBridgeOptions({
      initMode: 'custom',
      modelType: 'paddleocr_vl',
      maxNewTokens: 512,
      paddleocrVl: { maxPixels: 401408 },
      customConfig: {
        vision_encoder: { kind: 'fs', path: '/m/vision_encoder.onnx' },
        vision_encoder_data: {
          kind: 'fs',
          path: '/m/vision_encoder.onnx_data',
        },
        embedding: { kind: 'fs', path: '/m/embedding.onnx' },
        embedding_data: { kind: 'fs', path: '/m/embedding.onnx_data' },
        decoder: { kind: 'fs', path: '/m/decoder.onnx' },
        decoder_data: { kind: 'fs', path: '/m/decoder.onnx_data' },
        tokenizer: { kind: 'fs', path: '/m/tokenizer.json' },
        manifest: { kind: 'fs', path: '/m/ocr_manifest.json' },
      },
    });
    expect(bridge).toEqual(
      expect.objectContaining({
        initMode: 'custom',
        modelType: 'paddleocr_vl',
        maxNewTokens: 512,
        maxPixels: 401408,
        modelPaths: {
          vision_encoder: '/m/vision_encoder.onnx',
          vision_encoder_data: '/m/vision_encoder.onnx_data',
          embedding: '/m/embedding.onnx',
          embedding_data: '/m/embedding.onnx_data',
          decoder: '/m/decoder.onnx',
          decoder_data: '/m/decoder.onnx_data',
          tokenizer: '/m/tokenizer.json',
          manifest: '/m/ocr_manifest.json',
        },
      })
    );
    expect(bridge.modelDir).toBeUndefined();
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
