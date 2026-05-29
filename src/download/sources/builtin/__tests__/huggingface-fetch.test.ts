import { ModelCategory } from '../../../types';
import { sourceFetch } from '../../fetch';
import {
  configureHuggingFaceSource,
  huggingfaceProvider,
} from '../huggingface';

jest.mock('../../fetch', () => ({
  sourceFetch: jest.fn(),
}));

describe('huggingface provider listModels', () => {
  it('maps siblings to folder-layout assets', async () => {
    configureHuggingFaceSource({
      repos: {
        [ModelCategory.Stt]: [
          {
            repo: 'org/repo',
            revision: 'main',
            includeFiles: [/\.onnx$/i, /tokens\.txt$/i],
          },
        ],
      },
    });

    const mockedSourceFetch = sourceFetch as unknown as jest.Mock;
    mockedSourceFetch.mockResolvedValue({
      response: {
        json: async () => ({
          siblings: [
            {
              rfilename: 'model.onnx',
              size: 10,
            },
            {
              rfilename: 'tokens.txt',
              size: 5,
            },
            {
              rfilename: 'README.md',
              size: 1,
            },
          ],
        }),
      },
    });

    const models = await huggingfaceProvider.listModels(ModelCategory.Stt, {
      sourceId: 'huggingface',
      headers: {},
      requestPolicy: { retries: 0 },
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.layout.kind).toBe('folder');
    expect(models[0]?.assets.map((a) => a.relativePath)).toEqual([
      'model.onnx',
      'tokens.txt',
    ]);
  });
});
