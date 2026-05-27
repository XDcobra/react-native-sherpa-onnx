import { POCKET_TTS_ISO6391_HINTS } from './pocket';
import {
  isSupertonic3ModelKey,
  SUPERTONIC_TTS_ISO6391_HINTS,
} from './supertonic';
import { SUPERTONIC3_TTS_ISO6391_HINTS } from './supertonic3';

/**
 * Optional TTS-side language hints when native folder/catalog heuristics return no tags.
 * Per-model lists live alongside this file (e.g. `pocket.ts`, `supertonic.ts`).
 *
 * @param modelKey — catalog id, archive stem, or folder basename; used to pick Supertonic 3 hints.
 */
export function iso6391HintsForTtsModelType(
  modelType: string | undefined,
  modelKey?: string
): string[] | undefined {
  if (!modelType) {
    return undefined;
  }
  switch (modelType) {
    case 'pocket':
      return [...POCKET_TTS_ISO6391_HINTS];
    case 'supertonic':
      if (isSupertonic3ModelKey(modelKey)) {
        return [...SUPERTONIC3_TTS_ISO6391_HINTS];
      }
      return [...SUPERTONIC_TTS_ISO6391_HINTS];
    default:
      return undefined;
  }
}
