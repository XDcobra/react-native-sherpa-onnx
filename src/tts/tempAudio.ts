import {
  saveAlignmentAudioToTempWav as saveToTemp,
  type AlignmentAudioBuffer,
} from '../alignment/tempAudio';
import type { GeneratedAudio } from './types';

export type { AlignmentAudioBuffer };

export async function saveAlignmentAudioToTempWav(
  audio: GeneratedAudio | AlignmentAudioBuffer,
  instanceId?: string
): Promise<string> {
  // If this is a new-style GeneratedAudio (with getSamples), materialize first
  if ('getSamples' in audio && typeof audio.getSamples === 'function') {
    const samples = await audio.getSamples();
    return saveToTemp(
      { samples: Array.from(samples), sampleRate: audio.sampleRate },
      instanceId
    );
  }
  // Legacy AlignmentAudioBuffer path (already has samples array)
  return saveToTemp(audio as AlignmentAudioBuffer, instanceId);
}
