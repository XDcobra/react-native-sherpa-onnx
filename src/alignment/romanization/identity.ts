import type { Romanizer } from './types';

/** No-op romanizer — pass transcript through unchanged. */
export const identityRomanizer: Romanizer = {
  id: 'identity',
  romanize(text: string): string {
    return text;
  },
};
