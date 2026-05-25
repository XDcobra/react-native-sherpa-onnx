import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
  AudioSaveProgressEvent,
  PipelineAudioDeviceInfo,
} from './types';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';

let eventEmitter: NativeEventEmitter | null = null;
function getEventEmitter(): NativeEventEmitter {
  if (!eventEmitter) {
    eventEmitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  }
  return eventEmitter;
}

let idCounter = 0;
function generateOperationId(): string {
  return `save_${Date.now()}_${++idCounter}`;
}

function parseResolvedFileRef(result: {
  outputKind: string;
  outputPath: string;
}): ResolvedFileRef {
  if (result.outputKind === 'contentUri') {
    return { kind: 'contentUri', uri: result.outputPath };
  }
  return { kind: 'fs', path: result.outputPath };
}

/**
 * Type guard: returns true if the input is a FileSource (has a `kind` property
 * matching one of the FileSource discriminants).
 */
function isFileSource(input: AudioSaveInput): input is FileSource {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    typeof (input as any).kind === 'string' &&
    ['fs', 'app', 'contentUri', 'securityScoped', 'pad'].includes(
      (input as any).kind
    )
  );
}

/**
 * Map quality string to internal numeric value (0=default, 1=low, 2=medium, 3=high).
 */
function mapQuality(quality?: 'low' | 'medium' | 'high'): number {
  switch (quality) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

/**
 * Save audio to an encoded file at the given destination.
 *
 * Input can be:
 * - A pipeline audio buffer (offline or finalized live): ref, handle, info, or raw ID string.
 * - A FileSource for direct file-to-file encoding without intermediate buffers.
 *
 * Output: FileDestination descriptor.
 * Returns a ResolvedFileRef pointing to the written file.
 */
export async function saveAudioAsFile(
  input: AudioSaveInput,
  output: FileDestination,
  format: AudioOutputFormat,
  options?: SaveAudioOptions
): Promise<ResolvedFileRef> {
  const operationId = generateOperationId();
  const outputSampleRateHz = options?.outputSampleRateHz ?? 0;
  const bitrate = options?.bitrate ?? 0;
  const quality = mapQuality(options?.quality);

  let progressSubscription: { remove: () => void } | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    // Progress listener — listens to native "audioSaveProgress" events
    if (options?.onProgress) {
      const emitter = getEventEmitter();
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener('audioSaveProgress', ((
        rawEvent: unknown
      ) => {
        const event = rawEvent as AudioSaveProgressEvent;
        if (event.operationId === operationId) {
          onProgress(event);
        }
      }) as any);
    }

    // AbortSignal → native cancel
    if (options?.signal) {
      if (options.signal.aborted) {
        throw Object.assign(new Error('Operation cancelled'), {
          code: 'AUDIO_SAVE_CANCELLED',
        });
      }
      abortHandler = () => {
        SherpaOnnx.cancelAudioSave(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }

    let result: { outputKind: string; outputPath: string };

    if (isFileSource(input)) {
      // File-to-file path: AudioDecodeSession → AudioEncodeSession, no buffer registry
      result = await SherpaOnnx.saveFileAsAudioFile(
        input as any,
        output as any,
        format,
        outputSampleRateHz,
        bitrate,
        quality,
        operationId
      );
    } else {
      // Buffer path: resolve to string bufferId, look up in native registry
      result = await SherpaOnnx.saveAudioBufferToFile(
        resolvePipelineAudioBufferId(input),
        output as any,
        format,
        outputSampleRateHz,
        bitrate,
        quality,
        operationId
      );
    }

    return parseResolvedFileRef(result);
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Save audio as WAV 16 kHz mono 16-bit PCM.
 * Shortcut for saveAudioAsFile(input, output, 'wav', { outputSampleRateHz: 16000 }).
 *
 * Accepts both buffer references and FileSource.
 */
export function saveAudioAsWav16k(
  input: AudioSaveInput,
  output: FileDestination
): Promise<ResolvedFileRef> {
  return saveAudioAsFile(input, output, 'wav', {
    outputSampleRateHz: 16000,
  });
}

export type {
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
  AudioSaveProgressEvent,
  PipelineAudioProfile,
  PipelineAudioSessionConfig,
  PipelineAudioRoutePreference,
  PipelineAudioSessionState,
  PipelineAudioDeviceInfo,
} from './types';
export { AudioSaveErrorCode } from './types';
export type { AudioSaveErrorCodeValue } from './types';

// ── Pipeline Audio Session API ────────────────────────────────────────────

import type {
  PipelineAudioSessionConfig,
  PipelineAudioRoutePreference,
  PipelineAudioSessionState,
} from './types';

/**
 * Configure the pipeline audio session coordinator.
 * Call before starting mic/PCM operations to set session-level options.
 */
export async function configurePipelineAudioSession(
  config: PipelineAudioSessionConfig
): Promise<void> {
  await SherpaOnnx.configurePipelineAudioSession(config);
}

/**
 * Set the global audio route preference.
 * Applied to all active and future mic/PCM sessions.
 * On iOS this sets AVAudioSession preferred input/output; on Android it calls setPreferredDevice on all AudioRecord/AudioTrack instances.
 */
export async function setPipelineAudioRoutePreference(
  preference: PipelineAudioRoutePreference
): Promise<void> {
  await SherpaOnnx.setPipelineAudioRoutePreference(
    preference.inputDeviceId ?? null,
    preference.outputDeviceId ?? null
  );
}

/**
 * Clear the global audio route preference, reverting to system defaults.
 */
export async function clearPipelineAudioRoutePreference(): Promise<void> {
  await SherpaOnnx.clearPipelineAudioRoutePreference();
}

/**
 * Get a snapshot of the current pipeline audio session state.
 */
export async function getPipelineAudioSessionState(): Promise<PipelineAudioSessionState> {
  const snapshot = await SherpaOnnx.getPipelineAudioSessionState();
  return snapshot as PipelineAudioSessionState;
}

/**
 * List available microphone/input devices for global route selection.
 */
export async function listAvailableInputDevices(): Promise<
  PipelineAudioDeviceInfo[]
> {
  const raw = await SherpaOnnx.listAvailableInputDevices();
  return raw.map((device) => ({
    id: String(device.id),
    name: String(device.name),
    kind: String(device.kind),
    selected: Boolean(device.selected),
    default: Boolean(device.default),
    canSelect: Boolean(device.canSelect),
  }));
}

/**
 * List available output/playback devices for global route selection.
 */
export async function listAvailableOutputDevices(): Promise<
  PipelineAudioDeviceInfo[]
> {
  const raw = await SherpaOnnx.listAvailableOutputDevices();
  return raw.map((device) => ({
    id: String(device.id),
    name: String(device.name),
    kind: String(device.kind),
    selected: Boolean(device.selected),
    default: Boolean(device.default),
    canSelect: Boolean(device.canSelect),
  }));
}

export {
  probeAudioFileDuration,
  probeAudioFileContainer,
  type AudioFileDurationProbe,
  type AudioFileContainerProbe,
} from './probe';
