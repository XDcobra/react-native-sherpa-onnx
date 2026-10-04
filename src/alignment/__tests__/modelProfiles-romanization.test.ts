import {
  applyVocabRomanizerToProfile,
  hasAlignableAlignmentLetters,
  prepareAlignmentTranscript,
  resolveAlignmentPackProfile,
} from '../modelProfiles';
import {
  getRomanizer,
  identityRomanizer,
  inferRomanizerFromVocabTokens,
  latinDiacriticRomanizer,
} from '../romanization';

describe('alignment modelProfiles', () => {
  it('classifies known pack ids', () => {
    expect(resolveAlignmentPackProfile('wav2vec2-base-960h-int8').id).toBe(
      'wav2vec2_base_960h'
    );
    expect(resolveAlignmentPackProfile('wav2vec2-voxpopuli-de-base').id).toBe(
      'voxpopuli'
    );
    expect(
      resolveAlignmentPackProfile('mms-300m-1130-forced-aligner-int8').id
    ).toBe('mms_forced_aligner');
    expect(
      resolveAlignmentPackProfile('wav2vec2-xlsr-multilingual-56-q4f16').id
    ).toBe('xlsr_56');
  });

  it('romanizes only for MMS FA profile (uroman)', () => {
    const mms = resolveAlignmentPackProfile('mms-300m-1130-forced-aligner');
    expect(mms.needsRomanization).toBe(true);
    expect(mms.romanizerId).toBe('uroman');
    expect(prepareAlignmentTranscript('café', mms)).toBe('cafe');
    expect(prepareAlignmentTranscript('你好', mms, 'zh')).toBe('nihao');
    expect(
      hasAlignableAlignmentLetters(prepareAlignmentTranscript('你好', mms))
    ).toBe(true);

    const vox = resolveAlignmentPackProfile('wav2vec2-voxpopuli-de-base');
    expect(vox.needsRomanization).toBe(false);
    expect(prepareAlignmentTranscript('für groß', vox)).toBe('für groß');

    const xlsr = resolveAlignmentPackProfile(
      'wav2vec2-xlsr-multilingual-56-q4f16'
    );
    expect(xlsr.needsRomanization).toBe(false);
    expect(xlsr.romanizerId).toBe('identity');
    expect(prepareAlignmentTranscript('你好', xlsr)).toBe('你好');
  });

  it('vocab inference overrides name-based romanizer on a renamed pack', () => {
    const renamed = resolveAlignmentPackProfile('my-custom-aligner');
    expect(renamed.id).toBe('char_ctc_generic');
    expect(renamed.needsRomanization).toBe(false);

    const withMmsVocab = applyVocabRomanizerToProfile(
      renamed,
      inferRomanizerFromVocabTokens(['<blank>', 'a', 'b', 'z', "'"])
    );
    expect(withMmsVocab.id).toBe('char_ctc_generic');
    expect(withMmsVocab.needsRomanization).toBe(true);
    expect(withMmsVocab.romanizerId).toBe('uroman');
    expect(prepareAlignmentTranscript('你好', withMmsVocab, 'zh')).toBe(
      'nihao'
    );
  });
});

describe('alignment romanization', () => {
  it('identity leaves text unchanged', () => {
    expect(identityRomanizer.romanize('Straße')).toBe('Straße');
    expect(getRomanizer('identity').romanize('你好')).toBe('你好');
  });

  it('latinDiacritic strips combining marks but keeps base letters', () => {
    expect(latinDiacriticRomanizer.romanize('café naïve')).toBe('cafe naive');
    expect(latinDiacriticRomanizer.romanize('ÄÖÜ')).toBe('AOU');
  });

  it('hasAlignableAlignmentLetters accepts Unicode letters', () => {
    expect(hasAlignableAlignmentLetters('für')).toBe(true);
    expect(hasAlignableAlignmentLetters('[MUSIC]')).toBe(false);
    expect(hasAlignableAlignmentLetters('123')).toBe(false);
  });
});
