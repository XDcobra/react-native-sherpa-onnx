jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../catalogHints', () => {
  const actual = jest.requireActual('../../catalogHints');
  return {
    ...actual,
    buildCatalogHintsMap: jest.fn(async () => new Map()),
  };
});

import { ModelCategory } from '../../types';
import { buildSourceModelsFromGithubReleaseAssets } from '../github-common';
import { getSupplementFileNames } from '../supplement-rules';

const LEXICON_DIGEST = `sha256:${'ab'.repeat(32)}`;

function releaseAsset(name: string, size: number, digest?: string) {
  return {
    name,
    size,
    browser_download_url: `https://example.invalid/tts-models/${name}`,
    ...(digest ? { digest } : {}),
  };
}

describe('getSupplementFileNames', () => {
  it.each([
    'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
    'sherpa-onnx-zipvoice-distill-fp32-zh-en-emilia',
    'sherpa-onnx-zipvoice-zh-en-emilia',
    'kokoro-en-v0_19',
    'kokoro-int8-en-v0_19',
    'kitten-nano-en-v0_1-fp16',
    'kitten-mini-en-v0_8',
    'matcha-icefall-en_US-ljspeech',
    'vits-piper-en_US-lessac-medium',
    'vits-piper-en_GB-alan-low-int8',
  ])('adds the English lexicon to %s', (id) => {
    expect(getSupplementFileNames(ModelCategory.Tts, id)).toEqual([
      'lexicon-en-us.txt',
    ]);
  });

  it.each([
    // Ships lexicon-us-en.txt; a second English lexicon would change its pick.
    'kokoro-multi-lang-v1_0',
    'kokoro-int8-multi-lang-v1_1',
    // Ship their own lexicon.txt.
    'vits-ljs',
    'matcha-icefall-zh-baker',
    'matcha-icefall-zh-en',
    // Not English.
    'vits-piper-de_DE-thorsten-medium',
  ])('adds nothing to %s', (id) => {
    expect(getSupplementFileNames(ModelCategory.Tts, id)).toEqual([]);
  });

  it('only applies to its category', () => {
    expect(
      getSupplementFileNames(
        ModelCategory.Stt,
        'vits-piper-en_US-lessac-medium'
      )
    ).toEqual([]);
  });
});

describe('buildSourceModelsFromGithubReleaseAssets — supplements', () => {
  it('attaches the lexicon from the same release and counts it in bytes', async () => {
    const models = await buildSourceModelsFromGithubReleaseAssets(
      ModelCategory.Tts,
      [
        releaseAsset(
          'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2',
          1000
        ),
        releaseAsset('kokoro-multi-lang-v1_0.tar.bz2', 2000),
        releaseAsset('lexicon-en-us.txt', 30, LEXICON_DIGEST),
      ]
    );

    // The lexicon itself is not a model.
    expect(models.map((m) => m.id)).toEqual([
      'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia',
      'kokoro-multi-lang-v1_0',
    ]);

    const zipvoice = models[0];
    expect(zipvoice?.supplements).toEqual([
      {
        relativePath: 'lexicon-en-us.txt',
        url: 'https://example.invalid/tts-models/lexicon-en-us.txt',
        bytes: 30,
        sha256: 'ab'.repeat(32),
      },
    ]);
    expect(zipvoice?.bytes).toBe(1030);
    // The archive stays the only asset.
    expect(zipvoice?.assets).toHaveLength(1);
    expect(zipvoice?.assets[0]?.bytes).toBe(1000);

    const kokoro = models[1];
    expect(kokoro?.supplements).toBeUndefined();
    expect(kokoro?.bytes).toBe(2000);
  });

  it('attaches nothing when the release does not publish the file', async () => {
    const models = await buildSourceModelsFromGithubReleaseAssets(
      ModelCategory.Tts,
      [releaseAsset('vits-piper-en_US-lessac-medium.tar.bz2', 500)]
    );

    expect(models[0]?.supplements).toBeUndefined();
    expect(models[0]?.bytes).toBe(500);
  });
});
