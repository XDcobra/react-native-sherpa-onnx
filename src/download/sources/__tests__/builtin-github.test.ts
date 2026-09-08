jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../../detect', () => {
  const { detectModelResultMatchesCategory } = jest.requireActual(
    '../../../detect/detectModel'
  );
  return {
    detectModelsBatch: jest.fn(async (inputs: { assetName: string }[]) =>
      inputs.map((input) => {
        if (input.assetName.includes('spleeter')) {
          return {
            matched: true,
            category: 'separation',
            modelType: 'spleeter',
            languages: [],
            quantization: 'fp16',
            sizeTier: 'unknown',
            isStreaming: false,
          };
        }
        if (input.assetName.startsWith('UVR')) {
          return {
            matched: true,
            category: 'separation',
            modelType: 'uvr',
            languages: [],
            quantization: 'unknown',
            sizeTier: 'unknown',
            isStreaming: false,
          };
        }
        if (input.assetName.includes('sortformer')) {
          return {
            matched: true,
            category: 'diarization',
            modelType: 'sortformer',
            languages: [],
            quantization: 'unknown',
            sizeTier: 'unknown',
            isStreaming: true,
          };
        }
        return { matched: false };
      })
    ),
    detectModelResultMatchesCategory,
  };
});

import { ModelCategory } from '../../types';
import { getCategoryTag } from '../../paths';
import { githubK2FsaProvider, githubXdcobraProvider } from '../builtin';
import { buildSourceFetchContext } from '../registry';

describe('builtin github providers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('maps GitHub release assets to source models', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'sherpa-onnx-spleeter-2stems-fp16.tar.bz2',
              size: 123,
              browser_download_url: 'https://example.invalid/spleeter.tar.bz2',
              digest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            {
              name: 'UVR-MDX-NET-Inst_1.onnx',
              size: 456,
              browser_download_url: 'https://example.invalid/uvr.onnx',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          'sherpa-onnx-spleeter-2stems-fp16.tar.bz2 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      });

    global.fetch = fetchMock as typeof fetch;

    const ctx = buildSourceFetchContext(
      githubK2FsaProvider.id,
      githubK2FsaProvider,
      {
        headers: {
          'X-Test': '1',
        },
      }
    );

    const models = await githubK2FsaProvider.listModels(
      ModelCategory.Separation,
      ctx
    );
    const checksums = await githubK2FsaProvider.getChecksums?.(
      ModelCategory.Separation,
      ctx
    );

    expect(models).toHaveLength(2);

    const spleeter = models.find(
      (m) => m.id === 'sherpa-onnx-spleeter-2stems-fp16'
    );
    expect(spleeter?.layout.kind).toBe('archive');
    expect(spleeter?.modelType).toBe('spleeter');
    expect(spleeter?.assets[0]?.relativePath).toBe(
      'sherpa-onnx-spleeter-2stems-fp16.tar.bz2'
    );

    const uvr = models.find((m) => m.id === 'UVR-MDX-NET-Inst_1');
    expect(uvr?.layout.kind).toBe('folder');
    expect(uvr?.modelType).toBe('uvr');

    expect(checksums?.get('sherpa-onnx-spleeter-2stems-fp16.tar.bz2')).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `/releases/tags/${getCategoryTag(ModelCategory.Separation)}`
      ),
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
  });

  it('keeps category gating for XDcobra provider', () => {
    expect(
      githubXdcobraProvider.supportsCategory(ModelCategory.Alignment)
    ).toBe(true);
    expect(
      githubXdcobraProvider.supportsCategory(ModelCategory.Diarization)
    ).toBe(true);
    expect(githubXdcobraProvider.supportsCategory(ModelCategory.Tts)).toBe(
      false
    );
  });

  it('lists diarization models from XDcobra release tag and fetches checksums', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'diar_streaming_sortformer_4spk-v2.1.tar.bz2',
              size: 789,
              browser_download_url:
                'https://example.invalid/diar_streaming_sortformer_4spk-v2.1.tar.bz2',
              digest:
                'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          'diar_streaming_sortformer_4spk-v2.1.tar.bz2 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      });

    global.fetch = fetchMock as typeof fetch;

    const ctx = buildSourceFetchContext(
      githubXdcobraProvider.id,
      githubXdcobraProvider
    );

    const models = await githubXdcobraProvider.listModels(
      ModelCategory.Diarization,
      ctx
    );
    const checksums = await githubXdcobraProvider.getChecksums?.(
      ModelCategory.Diarization,
      ctx
    );

    expect(models).toHaveLength(1);
    const sortformer = models[0];
    expect(sortformer?.id).toBe('diar_streaming_sortformer_4spk-v2.1');
    expect(sortformer?.layout.kind).toBe('archive');
    expect(sortformer?.modelType).toBe('sortformer');
    expect(sortformer?.isStreaming).toBe(true);
    expect(sortformer?.assets[0]?.relativePath).toBe(
      'diar_streaming_sortformer_4spk-v2.1.tar.bz2'
    );

    expect(checksums?.get('diar_streaming_sortformer_4spk-v2.1.tar.bz2')).toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/releases/tags/diarization-models'),
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/releases/download/diarization-models/checksum.txt'
      ),
      expect.any(Object)
    );
  });
});
