import {
  supportsLexiconLanguageId,
  supportsKokoroInitLang,
} from '../languagePolicy';

describe('languagePolicy', () => {
  it('treats kitten as a lexicon model type', () => {
    expect(supportsLexiconLanguageId('kitten')).toBe(true);
    expect(supportsLexiconLanguageId('vits')).toBe(true);
    expect(supportsLexiconLanguageId('pocket')).toBe(false);
    expect(supportsLexiconLanguageId('supertonic')).toBe(false);
  });

  it('does not treat kitten as kokoro init-lang', () => {
    expect(supportsKokoroInitLang('kitten')).toBe(false);
    expect(supportsKokoroInitLang('kokoro')).toBe(true);
  });
});
