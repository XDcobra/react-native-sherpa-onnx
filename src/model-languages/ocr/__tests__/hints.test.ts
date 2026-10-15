import { ModelCategory } from '../../../download/types';
import {
  getPpocrLanguages,
  iso6391HintsForOcrModelType,
  OCR_PACK_ISO6391_HINTS_BY_ID,
  PPOCR_ISO6391_HINTS,
} from '../../generated/catalog';
import { publicLanguageHintsFromNative } from '../../resolvePublicLanguageHints';

describe('ocr language hints', () => {
  it('getPpocrLanguages returns PP-OCRv6 family set (zh/en/ja + Latin)', () => {
    const rows = getPpocrLanguages();
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['zh', 'en', 'ja', 'de', 'fr']));
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(PPOCR_ISO6391_HINTS).toEqual(
      expect.arrayContaining(['zh', 'en', 'ja', 'de', 'fr'])
    );
  });

  it('iso6391HintsForOcrModelType prefers pack CSV over family', () => {
    const tiny = iso6391HintsForOcrModelType('ppocr', 'ppocrv6-tiny');
    expect(tiny).toBeDefined();
    expect(tiny!).toEqual(expect.arrayContaining(['zh', 'en', 'de']));
    expect(tiny!).not.toContain('ja');
    expect(tiny!.length).toBeGreaterThanOrEqual(40);

    const small = iso6391HintsForOcrModelType('ppocr', 'ppocrv6-small');
    expect(small).toBeDefined();
    expect(small!).toEqual(expect.arrayContaining(['zh', 'en', 'ja', 'fr']));
    expect(small!.length).toBeGreaterThanOrEqual(40);

    expect(iso6391HintsForOcrModelType('ppocr')).toEqual(
      expect.arrayContaining(['zh', 'en', 'ja'])
    );
    expect(OCR_PACK_ISO6391_HINTS_BY_ID['ppocrv6-tiny']).toEqual(
      expect.arrayContaining(['zh', 'en'])
    );
    expect(OCR_PACK_ISO6391_HINTS_BY_ID['ppocrv6-tiny']).not.toContain('ja');
  });

  it('publicLanguageHintsFromNative does not invent OCR rows (C++ curated owns that)', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Ocr,
        modelType: 'ppocr',
        modelKey: 'ppocrv6-tiny',
        rawRows: [],
      })
    ).toEqual([]);
  });

  it('publicLanguageHintsFromNative normalizes native OCR rows', () => {
    expect(
      publicLanguageHintsFromNative({
        domain: ModelCategory.Ocr,
        modelType: 'ppocr',
        rawRows: [{ iso6391Hint: 'ZH', id: 'zh' }],
      })
    ).toEqual([{ iso6391Hint: 'zh', id: 'zh' }]);
  });
});
