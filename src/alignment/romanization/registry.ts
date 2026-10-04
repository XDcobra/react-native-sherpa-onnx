import { identityRomanizer } from './identity';
import { latinDiacriticRomanizer } from './latinDiacritic';
import type { Romanizer } from './types';

export type RomanizerId = 'identity' | 'latin_diacritic';

const REGISTRY: Record<RomanizerId, Romanizer> = {
  identity: identityRomanizer,
  latin_diacritic: latinDiacriticRomanizer,
};

export function getRomanizer(id: RomanizerId): Romanizer {
  return REGISTRY[id] ?? identityRomanizer;
}

export { identityRomanizer, latinDiacriticRomanizer };
export type { Romanizer } from './types';
