import {
  DEFAULT_TEXT_INPUT_NORMALIZATION,
  normalizePunctuationInputText,
  resolveTextInputNormalization,
} from '../textInputNormalization';

describe('textInputNormalization', () => {
  it('defaults to lower', () => {
    expect(resolveTextInputNormalization()).toBe('lower');
    expect(resolveTextInputNormalization(undefined)).toBe('lower');
    expect(DEFAULT_TEXT_INPUT_NORMALIZATION).toBe('lower');
  });

  it('honors explicit none', () => {
    expect(resolveTextInputNormalization('none')).toBe('none');
  });

  it('lowercases ASR uppercase input', () => {
    expect(
      normalizePunctuationInputText("HELLO WORLD I CAN'T COMPLAIN", 'lower')
    ).toBe("hello world i can't complain");
  });

  it('leaves text unchanged when mode is none', () => {
    expect(normalizePunctuationInputText('HELLO', 'none')).toBe('HELLO');
  });
});
