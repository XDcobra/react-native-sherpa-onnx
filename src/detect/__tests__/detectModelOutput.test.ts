import {
  readDetectedModels,
  readDetectionSources,
  readNonEmptyDetectPathsMap,
} from '../detectModelOutput';

describe('readNonEmptyDetectPathsMap', () => {
  it('keeps only non-empty string values', () => {
    expect(
      readNonEmptyDetectPathsMap({
        ttsModel: '/a/model.onnx',
        tokens: '/a/tokens.txt',
        dataDir: '',
        lexicon: '   ',
      })
    ).toEqual({
      ttsModel: '/a/model.onnx',
      tokens: '/a/tokens.txt',
    });
  });

  it('returns undefined for empty or invalid input', () => {
    expect(readNonEmptyDetectPathsMap(undefined)).toBeUndefined();
    expect(readNonEmptyDetectPathsMap({})).toBeUndefined();
  });
});

describe('readDetectionSources', () => {
  it('filters to known detection sources', () => {
    expect(
      readDetectionSources(['fileListing', 'invalid', 'nameOnly'])
    ).toEqual(['fileListing', 'nameOnly']);
  });
});

describe('readDetectedModels', () => {
  it('maps native detected model entries', () => {
    expect(
      readDetectedModels([
        { type: 'vits', modelDir: '/models/vits' },
        { type: 1, modelDir: '/bad' },
      ])
    ).toEqual([{ type: 'vits', modelDir: '/models/vits' }]);
  });
});
