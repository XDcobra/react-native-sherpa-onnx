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
  return saveToTemp(audio, instanceId);
}
