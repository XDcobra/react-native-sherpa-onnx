import { deriveLanguages } from '../deriveTtsLanguages';

describe('deriveLanguages', () => {
  it('collapses Piper-style ll_RR so region does not become a false ISO-639-1 code', () => {
    expect(deriveLanguages('vits-piper-nl_BE-rdh-medium')).toEqual(['nl']);
    expect(deriveLanguages('vits-piper-en_GB-sweetbbak-amy')).toEqual(['en']);
    expect(
      deriveLanguages('vits-piper-fa_en-rezahedayatfar-ibrahimwalk-medium')
    ).toEqual(['fa', 'en']);
  });

  it('uses only the Coqui language segment (ignores cv, mai, css10, etc.)', () => {
    expect(deriveLanguages('vits-coqui-pt-cv')).toEqual(['pt']);
    expect(deriveLanguages('vits-coqui-uk-mai')).toEqual(['uk']);
    expect(deriveLanguages('vits-coqui-en-ljspeech-neon')).toEqual(['en']);
    expect(deriveLanguages('vits-coqui-de-css10')).toEqual(['de']);
  });

  it('maps vits-mms ISO 639-2 codes to ISO 639-1', () => {
    expect(deriveLanguages('vits-mms-eng')).toEqual(['en']);
    expect(deriveLanguages('vits-mms-spa')).toEqual(['es']);
    expect(deriveLanguages('vits-mms-nan')).toEqual(['nan']);
  });

  it('preserves previous behaviour for compact locales and plain tokens', () => {
    expect(deriveLanguages('vits-piper-en_US-glados')).toEqual(['en']);
    expect(deriveLanguages('matcha-icefall-zh-en')).toEqual(['zh', 'en']);
    expect(deriveLanguages('vits-zh-hf-bronya')).toEqual(['zh']);
    expect(deriveLanguages('sherpa-onnx-vits-zh-ll')).toEqual(['zh']);
  });
});
