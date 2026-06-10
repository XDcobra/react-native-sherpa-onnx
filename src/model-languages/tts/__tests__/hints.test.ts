import { resolvePublicLanguageHints } from '../../resolvePublicLanguageHints';
import { ModelCategory } from '../../../download/types';
import { iso6391HintsForTtsModelType } from '../hints';
import { isSupertonic3ModelKey } from '../supertonic';
import { SUPERTONIC3_TTS_ISO6391_HINTS } from '../supertonic3';
import { SUPERTONIC_TTS_ISO6391_HINTS } from '../supertonic';

describe('isSupertonic3ModelKey', () => {
  it('detects Supertonic 3 catalog ids', () => {
    expect(
      isSupertonic3ModelKey('sherpa-onnx-supertonic-3-tts-int8-2026-05-11')
    ).toBe(true);
    expect(isSupertonic3ModelKey('supertonic-v3-demo')).toBe(true);
    expect(isSupertonic3ModelKey('supertonic3_release')).toBe(true);
  });

  it('does not treat legacy Supertonic bundles as v3', () => {
    expect(
      isSupertonic3ModelKey('sherpa-onnx-supertonic-tts-int8-2026-03-06')
    ).toBe(false);
    expect(isSupertonic3ModelKey('supertonic')).toBe(false);
  });
});

describe('iso6391HintsForTtsModelType (supertonic)', () => {
  it('uses legacy hints without a v3 model key', () => {
    expect(iso6391HintsForTtsModelType('supertonic')).toEqual([
      ...SUPERTONIC_TTS_ISO6391_HINTS,
    ]);
    expect(
      iso6391HintsForTtsModelType(
        'supertonic',
        'sherpa-onnx-supertonic-tts-int8-2026-03-06'
      )
    ).toEqual([...SUPERTONIC_TTS_ISO6391_HINTS]);
  });

  it('uses Supertonic 3 hints when model key contains version 3', () => {
    const hints = iso6391HintsForTtsModelType(
      'supertonic',
      'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'
    );
    expect(hints).toEqual([...SUPERTONIC3_TTS_ISO6391_HINTS]);
    expect(hints).toContain('na');
    expect(hints).toContain('de');
    expect(hints).toHaveLength(32);
  });
});

describe('resolvePublicLanguageHints (supertonic catalog)', () => {
  it('routes Supertonic 3 through modelKey', () => {
    const rows = resolvePublicLanguageHints({
      domain: ModelCategory.Tts,
      modelType: 'supertonic',
      modelKey: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    });
    expect(rows.map((r) => r.iso6391Hint)).toEqual([
      ...SUPERTONIC3_TTS_ISO6391_HINTS,
    ]);
  });
});
