import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

function toFileSource(pathOrUri: string): FileSource {
  const trimmed = pathOrUri.trim();

  if (trimmed.startsWith('content://')) {
    return { kind: 'contentUri', uri: trimmed };
  }

  if (trimmed.startsWith('file://')) {
    return { kind: 'fs', path: decodeURI(trimmed.replace(/^file:\/\//, '')) };
  }

  return { kind: 'fs', path: trimmed };
}

export type ActivePcmFilePlayback = {
  stop: () => Promise<void>;
};

type PcmFilePlaybackOptions = {
  outputDeviceId?: string;
};

export async function startPcmFilePlayback(
  pathOrUri: string,
  onPlaybackEnded?: () => void,
  options?: PcmFilePlaybackOptions
): Promise<ActivePcmFilePlayback> {
  const source = toFileSource(pathOrUri);
  const audioBuffer = await createOfflineAudioBufferFromFile(source, {
    forceMono: true,
  });

  const bufferId = audioBuffer.bufferId;
  let player: Awaited<ReturnType<typeof createPcmPlayer>> | null = null;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;

    if (player) {
      await player.destroy().catch(() => {});
      player = null;
    }

    await releasePipelineAudioBuffer(bufferId).catch(() => {});
  };

  try {
    player = await createPcmPlayer(bufferId, {
      outputDeviceId: options?.outputDeviceId,
      onEnded: () => {
        stop()
          .finally(() => {
            onPlaybackEnded?.();
          })
          .catch(() => {});
      },
    });

    return { stop };
  } catch (error) {
    await releasePipelineAudioBuffer(bufferId).catch(() => {});
    throw error;
  }
}

export async function stopPcmFilePlayback(
  activePlayback: ActivePcmFilePlayback | null
): Promise<void> {
  if (!activePlayback) return;
  await activePlayback.stop();
}
