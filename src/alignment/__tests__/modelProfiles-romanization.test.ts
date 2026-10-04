import {
  hasAlignableAlignmentLetters,
  prepareAlignmentTranscript,
  resolveAlignmentPackProfile,
} from '../modelProfiles';
import {
  getRomanizer,
  identityRomanizer,
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

  it('romanizes only for MMS FA profile', () => {
    const mms = resolveAlignmentPackProfile('mms-300m-1130-forced-aligner');
    expect(mms.needsRomanization).toBe(true);
    expect(prepareAlignmentTranscript('café', mms)).toBe('cafe');

    const vox = resolveAlignmentPackProfile('wav2vec2-voxpopuli-de-base');
    expect(vox.needsRomanization).toBe(false);
    expect(prepareAlignmentTranscript('für groß', vox)).toBe('für groß');
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
