import { ModelCategory } from '../../../download/types';
import {
  ALIGNMENT_PACK_ISO6391_HINTS_BY_ID,
  XLSR_MULTILINGUAL_ALIGNMENT_ISO6391_HINTS,
  alignmentPackLanguageStem,
  iso6391HintsForAlignmentModelType,
} from '../index';
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

  it('resolves pack-specific languages from sources.csv (not family-wide xlsr)', () => {
    expect(
      iso6391HintsForAlignmentModelType(
        'wav2vec2',
        'wav2vec2-voxpopuli-de-base'
      )
    ).toEqual(['de']);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'wav2vec2-xlsr-53-korean-int8'
      )
    ).toEqual(['ko']);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'wav2vec2-xlsr-53-vietnamese-fp16'
      )
    ).toEqual(['vi']);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'wav2vec2-xlsr-53-chinese-zh-cn-int8'
      )
    ).toEqual(['zh']);
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'wav2vec2-xlsr-turkish-q4f16'
      )
    ).toEqual(['tr']);
    // Stem lookup after stripping quant suffix
    expect(
      iso6391HintsForAlignmentModelType('unknown', 'wav2vec2-xlsr-53-korean')
    ).toEqual(['ko']);
  });

  it('keeps MMS empty (multilingual unenumerated) and fills multilingual-56 from CSV', () => {
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'mms-300m-1130-forced-aligner-int8'
      )
    ).toEqual([]);
    const multi = iso6391HintsForAlignmentModelType(
      'unknown',
      'wav2vec2-xlsr-multilingual-56-q4f16'
    );
    expect(multi).toEqual([...XLSR_MULTILINGUAL_ALIGNMENT_ISO6391_HINTS]);
    expect(multi?.length).toBeGreaterThan(40);
    expect(multi).toContain('de');
    expect(multi).toContain('vi');
  });

  it('does not treat bare xlsr third-party names as multilingual-56', () => {
    // Unknown pack with xlsr in the name: no CSV row → undefined (not 56 langs).
    expect(
      iso6391HintsForAlignmentModelType(
        'unknown',
        'acme-wav2vec2-xlsr-53-finnish-finetune'
      )
    ).toBeUndefined();
  });

  it('alignmentPackLanguageStem strips quant and trailing -base', () => {
    expect(alignmentPackLanguageStem('wav2vec2-xlsr-53-korean-int8')).toBe(
      'wav2vec2-xlsr-53-korean'
    );
    expect(alignmentPackLanguageStem('wav2vec2-voxpopuli-de-base')).toBe(
      'wav2vec2-voxpopuli-de'
    );
    expect(alignmentPackLanguageStem('wav2vec2-base-960h-int8')).toBe(
      'wav2vec2-base-960h'
    );
  });

  it('ships every sources.csv id in the generated pack map', () => {
    expect(
      ALIGNMENT_PACK_ISO6391_HINTS_BY_ID['wav2vec2-xlsr-53-korean-int8']
    ).toEqual(['ko']);
    expect(
      ALIGNMENT_PACK_ISO6391_HINTS_BY_ID['mms-300m-1130-forced-aligner-int8']
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
