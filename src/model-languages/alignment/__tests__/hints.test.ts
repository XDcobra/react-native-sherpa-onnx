import { ModelCategory } from '../../../download/types';
import { iso6391HintsForAlignmentModelType } from '../hints';
import { publicLanguageHintsFromNative } from '../../resolvePublicLanguageHints';

describe('alignment language hints', () => {
  it('iso6391HintsForAlignmentModelType returns en for wav2vec2', () => {
    expect(iso6391HintsForAlignmentModelType('wav2vec2')).toEqual(['en']);
    expect(
      iso6391HintsForAlignmentModelType('unknown', 'wav2vec2-base-960h-int8')
    ).toEqual(['en']);
    expect(iso6391HintsForAlignmentModelType('unknown', 'other-model')).toBeUndefined();
  });

  it('publicLanguageHintsFromNative falls back to en for empty Alignment rows', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Alignment,
        modelType: 'wav2vec2',
        modelKey: 'wav2vec2-base-960h-int8',
        rawRows: [],
      })
    ).toEqual([{ iso6391Hint: 'en', id: 'en' }]);
  });

  it('publicLanguageHintsFromNative prefers native Alignment rows', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Alignment,
        modelType: 'wav2vec2',
        rawRows: [{ iso6391Hint: 'vi', id: 'vi' }],
      })
    ).toEqual([{ iso6391Hint: 'vi', id: 'vi' }]);
  });
});
