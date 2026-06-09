import {
  iso6391HintsForSttModelType,
  iso6391HintsForTtsModelType,
  getWhisperLanguages,
  getFunasrNanoLanguages,
  getFunasrMltNanoLanguages,
  sttModelLanguagesForModelType,
  SUPERTONIC3_TTS_ISO6391_HINTS,
} from '../../generated/catalog';
import { publicLanguageHintsFromNative } from '../../resolvePublicLanguageHints';
import { ModelCategory } from '../../../download/types';
import fs from 'node:fs';
import path from 'node:path';

describe('generated catalog (TTS)', () => {
  it('iso6391HintsForTtsModelType picks Supertonic 3 vs legacy', () => {
    expect(iso6391HintsForTtsModelType('supertonic')).toEqual([
      'en',
      'ko',
      'fr',
      'es',
      'pt',
    ]);
    expect(
      iso6391HintsForTtsModelType(
        'supertonic',
        'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'
      )
    ).toEqual([...SUPERTONIC3_TTS_ISO6391_HINTS]);
  });

  it('publicLanguageHintsFromNative normalizes structured native rows', () => {
    const rows = publicLanguageHintsFromNative({
      domain: ModelCategory.Tts,
      modelType: 'supertonic',
      modelKey: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
      rawRows: [{ iso6391Hint: 'EN', id: 'en' }],
    });
    expect(rows).toEqual([{ iso6391Hint: 'en', id: 'en' }]);
  });

  it('publicLanguageHintsFromNative returns empty when native sends no rows', () => {
    const rows = publicLanguageHintsFromNative({
      domain: ModelCategory.Tts,
      modelType: 'supertonic',
      modelKey: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
      rawRows: [],
    });
    expect(rows).toEqual([]);
  });
});

describe('generated catalog parity with JSON', () => {
  const catalogPath = path.join(
    __dirname,
    '../../../../catalog/model-language-catalog.json'
  );
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  it('whisper picker matches JSON entries', () => {
    expect(getWhisperLanguages()).toEqual(catalog.stt.whisper.entries);
  });

  it('funasr picker variants come from JSON pickerVariants', () => {
    const funasr = catalog.stt.funasr_nano;
    expect(getFunasrNanoLanguages()).toEqual(funasr.pickerVariants.nano);
    expect(getFunasrMltNanoLanguages()).toEqual(funasr.pickerVariants.mlt);
  });

  it('funasr sttModelLanguagesForModelType uses entries not duplicated picker concat', () => {
    expect(sttModelLanguagesForModelType('funasr_nano')).toEqual(
      catalog.stt.funasr_nano.entries
    );
  });

  it('STT whisper hints derived from JSON entries', () => {
    const hints = iso6391HintsForSttModelType('whisper');
    expect(hints?.length).toBeGreaterThan(50);
    expect(hints).toContain('en');
    expect(hints).toContain('yue');
  });
});
