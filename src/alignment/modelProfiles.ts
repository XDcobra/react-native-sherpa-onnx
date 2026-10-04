import type { RomanizerId } from './romanization';
import {
  getRomanizer,
  type Romanizer,
  type VocabRomanizerInference,
} from './romanization';
import type {
  AlignmentConcreteModelFamily,
  AlignmentModelFamily,
} from './types';

export type { AlignmentConcreteModelFamily, AlignmentModelFamily };

/** Heuristic profile for a concrete alignment pack / id. */
export type AlignmentPackProfileId =
  | 'wav2vec2_base_960h'
  | 'voxpopuli'
  | 'mms_forced_aligner'
  | 'xlsr_56'
  | 'char_ctc_generic';

export interface AlignmentModelProfile {
  /** Pack profile id (for logging / tests). */
  id: AlignmentPackProfileId;
  /** Detect / custom-init family string. */
  family: AlignmentConcreteModelFamily;
  /** Whether transcript should be romanized before native CTC. */
  needsRomanization: boolean;
  romanizerId: RomanizerId;
  /** Language hints for catalog / UX (ISO 639-1). */
  languageHints: readonly string[];
}

const PROFILES: Record<AlignmentPackProfileId, AlignmentModelProfile> = {
  wav2vec2_base_960h: {
    id: 'wav2vec2_base_960h',
    family: 'wav2vec2',
    needsRomanization: false,
    romanizerId: 'identity',
    languageHints: ['en'],
  },
  voxpopuli: {
    id: 'voxpopuli',
    family: 'wav2vec2',
    // Keep European diacritics — vocab has ä/ö/ü/ß etc.
    needsRomanization: false,
    romanizerId: 'identity',
    languageHints: ['de', 'es', 'fr', 'it'],
  },
  mms_forced_aligner: {
    id: 'mms_forced_aligner',
    family: 'wav2vec2',
    needsRomanization: true,
    // ASCII-romanized vocab: uroman + MMS normalize (covers non-Latin scripts).
    romanizerId: 'uroman',
    languageHints: [],
  },
  xlsr_56: {
    id: 'xlsr_56',
    family: 'wav2vec2',
    // Native-script vocab — do not uroman (would destroy alignable chars).
    needsRomanization: false,
    romanizerId: 'identity',
    languageHints: [],
  },
  char_ctc_generic: {
    id: 'char_ctc_generic',
    family: 'wav2vec2',
    needsRomanization: false,
    romanizerId: 'identity',
    languageHints: [],
  },
};

/**
 * Resolve a pack profile from a model directory basename, ONNX path, or asset id.
 */
export function resolveAlignmentPackProfile(
  hint: string | undefined | null
): AlignmentModelProfile {
  const key = (hint ?? '').toLowerCase();
  if (!key) {
    return PROFILES.char_ctc_generic;
  }
  if (key.includes('mms') && key.includes('forced-aligner')) {
    return PROFILES.mms_forced_aligner;
  }
  if (key.includes('mms-300m-1130') || key.includes('mms_300m_1130')) {
    return PROFILES.mms_forced_aligner;
  }
  if (key.includes('voxpopuli')) {
    return PROFILES.voxpopuli;
  }
  if (key.includes('xlsr') || key.includes('multilingual-56')) {
    return PROFILES.xlsr_56;
  }
  if (key.includes('960h') || key.includes('wav2vec2-base')) {
    return PROFILES.wav2vec2_base_960h;
  }
  return PROFILES.char_ctc_generic;
}

export function romanizerForProfile(profile: AlignmentModelProfile): Romanizer {
  return getRomanizer(profile.romanizerId);
}

/**
 * Override only romanizer fields from vocab charset inference.
 * Pack `id` / `languageHints` stay name-based.
 */
export function applyVocabRomanizerToProfile(
  profile: AlignmentModelProfile,
  inference: VocabRomanizerInference
): AlignmentModelProfile {
  return {
    ...profile,
    needsRomanization: inference.needsRomanization,
    romanizerId: inference.romanizerId,
  };
}

/**
 * Prepare transcript for a profile: apply romanizer when needed.
 */
export function prepareAlignmentTranscript(
  text: string,
  profile: AlignmentModelProfile,
  language?: string
): string {
  if (!profile.needsRomanization) {
    return text;
  }
  return romanizerForProfile(profile).romanize(text, language);
}

/**
 * After optional romanization, does the text still contain alignable letters?
 * Broader than A–Z: any Unicode letter counts (VoxPopuli umlauts, XLSR chars).
 */
export function hasAlignableAlignmentLetters(text: string): boolean {
  const stripped = text.replace(/\[(?:[A-Z][A-Z0-9_ ]{0,48})\]/g, ' ');
  return /\p{L}/u.test(stripped);
}
