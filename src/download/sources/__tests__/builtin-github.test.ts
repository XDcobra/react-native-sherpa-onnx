jest.mock('../../../detect', () => ({
  detectModelsBatch: jest.fn(async () => []),
  detectModelResultMatchesCategory: jest.fn(() => true),
}));

import { ModelCategory } from '../../types';
import { getCategoryTag } from '../../paths';
import { githubK2FsaProvider, githubXdcobraProvider } from '../builtin';
import { buildSourceFetchContext } from '../registry';

describe('builtin github providers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it('maps GitHub release assets to source models', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'sherpa-onnx-test-model.tar.bz2',
              size: 123,
              browser_download_url: 'https://example.invalid/model.tar.bz2',
              digest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          'sherpa-onnx-test-model.tar.bz2 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
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

    expect(models).toHaveLength(1);
    expect(models[0]?.layout.kind).toBe('archive');
    expect(models[0]?.assets[0]?.relativePath).toBe(
      'sherpa-onnx-test-model.tar.bz2'
    );
    expect(checksums?.get('sherpa-onnx-test-model.tar.bz2')).toBe(
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
    expect(githubXdcobraProvider.supportsCategory(ModelCategory.Tts)).toBe(
      false
    );
  });
});
