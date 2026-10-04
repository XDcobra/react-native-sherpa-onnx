import fs from 'node:fs';
import path from 'node:path';
import {
  inferRomanizerFromVocabTokens,
  tokensFromVocabJson,
} from '../inferFromVocab';

const FIXTURES = path.join(__dirname, '../../../../test/fixtures/alignment');

function loadFixtureTokens(name: string): string[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, name), 'utf8')
  ) as unknown;
  const tokens = tokensFromVocabJson(raw);
  if (!tokens) {
    throw new Error(`invalid fixture ${name}`);
  }
  return tokens;
}

describe('inferRomanizerFromVocabTokens', () => {
  it('selects uroman for MMS FA ASCII vocab', () => {
    expect(
      inferRomanizerFromVocabTokens(loadFixtureTokens('vocab_mms_fa.json'))
    ).toEqual({ needsRomanization: true, romanizerId: 'uroman' });
  });

  it('selects identity for VoxPopuli diacritic vocab', () => {
    expect(
      inferRomanizerFromVocabTokens(
        loadFixtureTokens('vocab_voxpopuli_de.json')
      )
    ).toEqual({ needsRomanization: false, romanizerId: 'identity' });
  });

  it('selects identity when non-Latin letters are present', () => {
    expect(
      inferRomanizerFromVocabTokens(
        loadFixtureTokens('vocab_xlsr_nonlatin_sample.json')
      )
    ).toEqual({ needsRomanization: false, romanizerId: 'identity' });
  });

  it('selects identity when there are no letter tokens', () => {
    expect(inferRomanizerFromVocabTokens(['<pad>', '|', '1'])).toEqual({
      needsRomanization: false,
      romanizerId: 'identity',
    });
  });
});
