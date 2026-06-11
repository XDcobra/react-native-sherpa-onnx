jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../catalogHints', () => {
  const actual = jest.requireActual('../../catalogHints');
  return {
    ...actual,
    buildCatalogHintsMap: jest.fn(async () => {
      return new Map([
        [
          'sherpa-onnx-spleeter-2stems-fp16',
          {
            modelType: 'spleeter',
            languages: [],
            quantization: 'fp16',
            sizeTier: 'unknown',
            isStreaming: false,
          },
        ],
        [
          'UVR-MDX-NET-Inst_1',
          {
            modelType: 'uvr',
            languages: [],
            quantization: 'unknown',
            sizeTier: 'unknown',
            isStreaming: false,
          },
        ],
      ]);
    }),
  };
});

import { ModelCategory } from '../../types';
import { buildSourceModelsFromGithubReleaseAssets } from '../github-common';

describe('buildSourceModelsFromGithubReleaseAssets — Separation', () => {
  it('maps Spleeter archives and UVR ONNX with catalog detect hints', async () => {
    const models = await buildSourceModelsFromGithubReleaseAssets(
      ModelCategory.Separation,
      [
        {
          name: 'sherpa-onnx-spleeter-2stems-fp16.tar.bz2',
          size: 1_000_000,
          browser_download_url: 'https://example.invalid/spleeter.tar.bz2',
        },
        {
          name: 'UVR-MDX-NET-Inst_1.onnx',
          size: 50_000_000,
          browser_download_url: 'https://example.invalid/uvr.onnx',
        },
      ]
    );

    expect(models).toHaveLength(2);

    const spleeter = models.find(
      (m) => m.id === 'sherpa-onnx-spleeter-2stems-fp16'
    );
    expect(spleeter?.layout).toEqual({
      kind: 'archive',
      format: 'tar.bz2',
      extract: true,
    });
    expect(spleeter?.modelType).toBe('spleeter');
    expect(spleeter?.isStreaming).toBe(false);

    const uvr = models.find((m) => m.id === 'UVR-MDX-NET-Inst_1');
    expect(uvr?.layout).toEqual({
      kind: 'folder',
      format: 'none',
      extract: false,
    });
    expect(uvr?.modelType).toBe('uvr');
    expect(uvr?.assets[0]?.relativePath).toBe('UVR-MDX-NET-Inst_1.onnx');
  });
});
