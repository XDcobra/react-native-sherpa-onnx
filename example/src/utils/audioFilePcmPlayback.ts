import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import { toFileSource } from './fileSourceFromUri';

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
    if (options?.outputDeviceId != null) {
      await setPipelineAudioRoutePreference({
        outputDeviceId: options.outputDeviceId,
      }).catch(() => {});
    }
    player = await createPcmPlayer(bufferId, {
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
