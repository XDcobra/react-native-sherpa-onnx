import { ModelCategory } from '../../../download/types';
import {
  DOCTR_ISO6391_HINTS,
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

describe('doctr language hints', () => {
  it('iso6391HintsForOcrModelType returns doctr family hints', () => {
    const hints = iso6391HintsForOcrModelType('doctr');
    expect(hints).toBeDefined();
    expect(hints).toContain('en');
    expect(hints).toContain('fr');
    expect(hints!.length).toBeGreaterThanOrEqual(2);
  });

  it('iso6391HintsForOcrModelType prefers doctr-mobile pack over family', () => {
    const mobile = iso6391HintsForOcrModelType('doctr', 'doctr-mobile');
    expect(mobile).toEqual(['en', 'fr']);
  });

  it('iso6391HintsForOcrModelType prefers doctr-default pack over family', () => {
    const dflt = iso6391HintsForOcrModelType('doctr', 'doctr-default');
    expect(dflt).toContain('en');
    expect(dflt).toContain('pt');
    expect(dflt).toContain('ro');
    expect(dflt!.length).toBe(15);
  });

  it('DOCTR_ISO6391_HINTS contains family-level hints', () => {
    expect(DOCTR_ISO6391_HINTS).toBeDefined();
    expect(DOCTR_ISO6391_HINTS.length).toBeGreaterThanOrEqual(2);
    expect(DOCTR_ISO6391_HINTS).toContain('en');
    expect(DOCTR_ISO6391_HINTS).toContain('fr');
  });

  it('publicLanguageHintsFromNative resolves doctr family hints from native rows', () => {
    const resolved = publicLanguageHintsFromNative({
      domain: ModelCategory.Ocr,
      modelType: 'doctr',
      modelKey: 'doctr-mobile',
      rawRows: [
        { iso6391Hint: 'en', id: 'en' },
        { iso6391Hint: 'fr', id: 'fr' },
      ],
    });
    expect(resolved).toEqual([
      { iso6391Hint: 'en', id: 'en' },
      { iso6391Hint: 'fr', id: 'fr' },
    ]);
  });
});
