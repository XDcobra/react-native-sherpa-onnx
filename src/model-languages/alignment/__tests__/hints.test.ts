import { ModelCategory } from '../../../download/types';
import { iso6391HintsForAlignmentModelType } from '../index';
import { publicLanguageHintsFromNative } from '../../resolvePublicLanguageHints';

describe('alignment language hints', () => {
  it('iso6391HintsForAlignmentModelType returns en for wav2vec2', () => {
    expect(iso6391HintsForAlignmentModelType('wav2vec2')).toEqual(['en']);
    expect(
      iso6391HintsForAlignmentModelType('unknown', 'wav2vec2-base-960h-int8')
    ).toEqual(['en']);
    expect(
      iso6391HintsForAlignmentModelType('unknown', 'other-model')
    ).toBeUndefined();
  });

  it('returns pack-specific hints for VoxPopuli / MMS / XLSR keys', () => {
    expect(
      iso6391HintsForAlignmentModelType(
        'wav2vec2',
        'wav2vec2-voxpopuli-de-base'
      )
    ).toEqual(['de', 'es', 'fr', 'it']);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'mms-300m-1130-forced-aligner-int8'
      )
    ).toEqual([]);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'wav2vec2-xlsr-multilingual-56-q4f16'
      )
    ).toEqual([]);
  });

  it('publicLanguageHintsFromNative does not invent Alignment rows (C++ curated catalog owns that)', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Alignment,
        modelType: 'wav2vec2',
        modelKey: 'wav2vec2-base-960h-int8',
        rawRows: [],
      })
    ).toEqual([]);
  });

  it('publicLanguageHintsFromNative normalizes native Alignment rows', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Alignment,
        modelType: 'wav2vec2',
        rawRows: [{ iso6391Hint: 'EN', id: 'en' }],
      })
    ).toEqual([{ iso6391Hint: 'en', id: 'en' }]);
  });
});
