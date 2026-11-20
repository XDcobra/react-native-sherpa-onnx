jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/docs',
  exists: jest.fn(async () => false),
  readFile: jest.fn(),
  writeFile: jest.fn(async () => {}),
  mkdir: jest.fn(async () => {}),
}));

jest.mock('../../detect', () => ({
  detectModelsBatch: jest.fn(async () => []),
  detectModelResultMatchesCategory: jest.fn(() => true),
}));

import { refreshModels } from '../registry';
import { registerSource, unregisterSource } from '../sources';
import type { SourceProvider } from '../sources';
import { ModelCategory } from '../types';

const SOURCE_ID = 'supplement_test_source';

const provider: SourceProvider = {
  id: SOURCE_ID,
  label: 'Supplement test',
  supportsCategory: (category) => category === ModelCategory.Tts,
  listModels: async () => [
    {
      id: 'vits-piper-en_US-lessac-medium',
      displayName: 'Piper',
      category: ModelCategory.Tts,
      layout: { kind: 'archive', format: 'tar.bz2', extract: true },
      assets: [
        {
          relativePath: 'vits-piper-en_US-lessac-medium.tar.bz2',
          url: 'https://example.invalid/piper.tar.bz2',
          bytes: 100,
        },
      ],
      supplements: [
        {
          relativePath: 'lexicon-en-us.txt',
          url: 'https://example.invalid/lexicon-en-us.txt',
          bytes: 10,
          sha256: 'AA'.repeat(32),
        },
      ],
      bytes: 110,
    },
  ],
  getChecksums: async () => new Map([['lexicon-en-us.txt', 'cd'.repeat(32)]]),
};

describe('refreshModels — supplements', () => {
  beforeAll(() => registerSource(provider));
  afterAll(() => unregisterSource(SOURCE_ID));

  it('keeps supplements on the catalog entry and takes their checksum from the source', async () => {
    const [model] = await refreshModels(ModelCategory.Tts, {
      source: SOURCE_ID,
      forceRefresh: true,
    });

    expect(model?.bytes).toBe(110);
    expect(model?.supplements).toEqual([
      {
        relativePath: 'lexicon-en-us.txt',
        url: 'https://example.invalid/lexicon-en-us.txt',
        bytes: 10,
        sha256: 'cd'.repeat(32),
      },
    ]);
  });
});
