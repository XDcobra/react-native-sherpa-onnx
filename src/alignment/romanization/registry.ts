import { identityRomanizer } from './identity';
import { latinDiacriticRomanizer } from './latinDiacritic';
import { uromanRomanizer } from './uroman';
import type { Romanizer } from './types';

export type RomanizerId = 'identity' | 'latin_diacritic' | 'uroman';

const REGISTRY: Record<RomanizerId, Romanizer> = {
  identity: identityRomanizer,
  latin_diacritic: latinDiacriticRomanizer,
  uroman: uromanRomanizer,
};

export function getRomanizer(id: RomanizerId): Romanizer {
  return REGISTRY[id] ?? identityRomanizer;
}

export { identityRomanizer, latinDiacriticRomanizer, uromanRomanizer };
export type { Romanizer } from './types';
