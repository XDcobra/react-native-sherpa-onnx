import type { Romanizer } from '../types';
import { romanizeString } from './engine';
import { mmsNormalize } from './mmsNormalize';

/**
 * uroman-class romanizer for ASCII-romanized vocabs (MMS FA).
 * Applies uroman tables, then torchaudio-style MMS ASCII normalize.
 */
export const uromanRomanizer: Romanizer = {
  id: 'uroman',
  romanize(text: string, language?: string): string {
    if (!text) {
      return text;
    }
    return mmsNormalize(romanizeString(text, language));
  },
};

export { romanizeString } from './engine';
export { mmsNormalize } from './mmsNormalize';
export { toUromanLanguageCode } from './langCodes';
