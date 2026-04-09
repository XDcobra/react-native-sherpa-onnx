import { POCKET_TTS_ISO6391_HINTS } from './pocket';
import { SUPERTONIC_TTS_ISO6391_HINTS } from './supertonic';

/**
 * Optional TTS-side language hints when native folder/catalog heuristics return no tags.
 * Per-model lists live alongside this file (e.g. `pocket.ts`, `supertonic.ts`).
 */
export function iso6391HintsForTtsModelType(
  modelType: string | undefined
): string[] | undefined {
  if (!modelType) {
    return undefined;
  }
  switch (modelType) {
    case 'pocket':
      return [...POCKET_TTS_ISO6391_HINTS];
    case 'supertonic':
      return [...SUPERTONIC_TTS_ISO6391_HINTS];
    default:
      return undefined;
  }
}
