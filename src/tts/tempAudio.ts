import { DocumentDirectoryPath, mkdir } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import type { GeneratedAudio } from './types';

function createTempAlignmentWavPath(instanceId?: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const prefix = instanceId?.trim() ? `${instanceId}-` : '';
  return `${DocumentDirectoryPath}/sherpa-onnx/cache/${prefix}alignment-${nonce}.wav`.replace(
    /\/+/g,
    '/'
  );
}

export async function saveAlignmentAudioToTempWav(
  audio: GeneratedAudio,
  instanceId?: string
): Promise<string> {
  const cacheDir = `${DocumentDirectoryPath}/sherpa-onnx/cache`.replace(
    /\/+/g,
    '/'
  );
  await mkdir(cacheDir);

  const tempPath = createTempAlignmentWavPath(instanceId);
  await SherpaOnnx.saveTtsAudioToFile(
    audio.samples,
    audio.sampleRate,
    tempPath
  );
  return tempPath;
}
