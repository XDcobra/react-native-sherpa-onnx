import { DocumentDirectoryPath, mkdir } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';

function createTempAlignmentWavPath(instanceId?: string): string {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const prefix = instanceId?.trim() ? `${instanceId}-` : '';
  return `${DocumentDirectoryPath}/sherpa-onnx/cache/${prefix}alignment-${nonce}.wav`.replace(
    /\/+/g,
    '/'
  );
}

/** Mono float PCM + sample rate (same shape as TTS `GeneratedAudio`). */
export type AlignmentAudioBuffer = {
  samples: number[];
  sampleRate: number;
};

export async function saveAlignmentAudioToTempWav(
  audio: AlignmentAudioBuffer,
  instanceId?: string
): Promise<string> {
  const cacheDir = `${DocumentDirectoryPath}/sherpa-onnx/cache`.replace(
    /\/+/g,
    '/'
  );
  await mkdir(cacheDir);

  const tempPath = createTempAlignmentWavPath(instanceId);
  await SherpaOnnx.saveTtsAudio(
    audio.samples,
    audio.sampleRate,
    'file',
    tempPath,
    '',
    'wav',
    0
  );
  return tempPath;
}
