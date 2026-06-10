import { Platform } from 'react-native';
import {
  pick,
  pickDirectory,
  saveDocuments,
  types,
  isErrorWithCode,
  errorCodes,
} from '@react-native-documents/picker';
import {
  DocumentDirectoryPath,
  mkdir,
  unlink,
} from '@dr.pogodin/react-native-fs';
import {
  probeAudioFileDuration,
  saveAudioAsFile,
  type AudioOutputFormat,
  type AudioSaveInput,
} from 'react-native-sherpa-onnx/audio';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from 'react-native-sherpa-onnx/fileio';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

import { formatResolvedLocation } from '../../components/audioSaveUtils';
import { describeFileSource } from '../../utils/fileSourceFromUri';
import type { FileioInputSource } from './fileioInputChannels';

export type { FileioInputSource } from './fileioInputChannels';
export {
  listFileioInputChannels,
  pickFileioInputForChannel,
  resolveBundledCodecSource,
  resolveBundledWavLegacy,
  resolveFileioInputSource,
} from './fileioInputChannels';
export type {
  FileioInputChannelId,
  FileioInputChannelMeta,
  FileioSampleSelection,
} from './fileioInputChannels';

/** Matches the “Audio source” cards on {@link FileIOScreen} (encode only). */
export type AudioSourceChoice =
  | 'liveAudioBuffer'
  | 'offlineAudioBuffer'
  | 'assetAudioFile';

export type FileioOperation = 'probe' | 'decode' | 'encode';

export const FILEIO_OUTPUT_FORMATS: AudioOutputFormat[] = [
  'wav',
  'mp3',
  'flac',
  'aac',
  'm4a',
  'opus',
  'webm',
  'mkv',
  'ogg',
];

/** Payload when the user runs encode (Copy) on the File I/O screen. */
export type FileioCopyInput = {
  destinationKind: FileDestination['kind'];
  audioSource: AudioSourceChoice;
  inputSource: FileSource;
  inputLabel: string;
  outputFormat: AudioOutputFormat;
  outputSampleRateHz?: number;
};

export type FileioCopyResult =
  | { status: 'success'; resolved: ResolvedFileRef; detail: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

export type FileioProbeResult =
  | { status: 'success'; durationMs: number; isExact: boolean; detail: string }
  | { status: 'error'; message: string };

export type FileioDecodeResult =
  | {
      status: 'success';
      bufferId: string;
      sampleRate: number;
      channelCount: number;
      numSamples: number;
      durationMs: number;
      detail: string;
    }
  | { status: 'error'; message: string };

const FS_EXPORT_DIR = `${DocumentDirectoryPath}/SherpaOnnxFileIO/exports`;
const APP_EXPORT_RELATIVE = 'SherpaOnnxFileIO/exports';

function isPickCanceled(err: unknown): boolean {
  if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
    return true;
  }
  return false;
}

export function defaultSampleRateForFormat(format: AudioOutputFormat): number {
  return format === 'wav' ? 16000 : 0;
}

export function mimeTypeForFormat(format: AudioOutputFormat): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'm4a':
      return 'audio/mp4';
    case 'opus':
      return 'audio/opus';
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}

function exportFilename(
  format: AudioOutputFormat,
  prefix = 'fileio-copy'
): string {
  return `${prefix}-${Date.now()}.${format}`;
}

function isBundledTestPath(rel: string | undefined): rel is string {
  return (
    !!rel && (rel.startsWith('test_codec/') || rel.startsWith('test_wavs/'))
  );
}

function looksLikeMissingBundledAsset(nativeMessage: string): boolean {
  const lower = nativeMessage.toLowerCase();
  return (
    lower.includes('apk asset not found') ||
    lower.includes('probe_open_failed') ||
    lower.includes('probe_not_found') ||
    lower.includes('source file not found') ||
    lower.includes('cannot open file')
  );
}

function formatFileioNativeError(
  source: FileSource,
  bundledPath: string | undefined,
  err: unknown
): string {
  const code =
    err instanceof Error &&
    typeof (err as Error & { code?: unknown }).code === 'string'
      ? String((err as Error & { code?: unknown }).code)
      : null;
  const base = err instanceof Error ? err.message : String(err);
  const baseWithCode = code ? `[${code}] ${base}` : base;
  const rel =
    bundledPath ??
    (source.kind === 'app' && source.base === 'files'
      ? source.path
      : undefined);

  if (!isBundledTestPath(rel)) {
    return baseWithCode;
  }

  if (looksLikeMissingBundledAsset(base)) {
    return [
      `Missing bundled file: ${rel}`,
      Platform.OS === 'android'
        ? 'Android: place under example/android/app/src/main/assets/ and use app/apkAsset (not app/files).'
        : 'iOS: place under example/ios/sherpa_models/ and rebuild.',
      'See test_codec/README in assets and sherpa_models.',
      '',
      `Native: ${baseWithCode}`,
    ].join('\n');
  }

  return [
    `Failed for: ${rel}`,
    describeFileSource(source),
    '',
    `Native: ${baseWithCode}`,
  ].join('\n');
}

function formatProbeNullError(
  input: FileioInputSource,
  bundledPath: string | undefined
): string {
  if (isBundledTestPath(bundledPath)) {
    return `Probe returned no duration: ${bundledPath}`;
  }
  return [
    `Probe returned no duration for: ${input.label}`,
    describeFileSource(input.fileSource),
  ].join('\n');
}

function buildContentTreeDestination(
  treeOrFolderUri: string,
  filename: string,
  mimeType: string
): FileDestination {
  if (Platform.OS === 'ios') {
    // Keep deterministic behavior: pass unsupported kind directly to SDK.
    return {
      kind: 'contentTree',
      treeUri: 'content://unsupported-on-ios',
      filename,
      mimeType,
    };
  }

  const trimmed = treeOrFolderUri.trim();
  if (trimmed.startsWith('content://')) {
    return {
      kind: 'contentTree',
      treeUri: trimmed,
      filename,
      mimeType,
    };
  }
  throw new Error('Folder picker must return content:// for contentTree.');
}

async function pickContentTreeDestination(
  format: AudioOutputFormat
): Promise<FileDestination> {
  const picked = await pickDirectory({ requestLongTermAccess: false });
  const uri = picked.uri?.trim();
  if (!uri) {
    throw new Error('Folder picker did not return a URI.');
  }
  const filename = exportFilename(format);
  return buildContentTreeDestination(uri, filename, mimeTypeForFormat(format));
}

async function pickSecurityScopedDestination(): Promise<FileDestination> {
  if (Platform.OS !== 'ios') {
    throw new Error(
      'securityScoped destinations are for iOS. On Android use contentTree or app/fs.'
    );
  }
  const picked = await pick({
    mode: 'open',
    requestLongTermAccess: true,
    type: [types.audio],
  });
  const file = picked[0];
  const uri = file?.uri?.trim();
  if (!uri) {
    throw new Error('Document picker did not return a URI.');
  }
  return { kind: 'securityScoped', uri };
}

async function fixedDestinationForKind(
  kind: 'fs' | 'app',
  format: AudioOutputFormat
): Promise<FileDestination> {
  const filename = exportFilename(format);
  if (kind === 'fs') {
    await mkdir(FS_EXPORT_DIR, { NSURLIsExcludedFromBackupKey: false }).catch(
      () => {}
    );
    return { kind: 'fs', path: `${FS_EXPORT_DIR}/${filename}` };
  }
  return {
    kind: 'app',
    base: 'documents',
    path: `${APP_EXPORT_RELATIVE}/${filename}`,
  };
}

type PreparedInput = {
  input: AudioSaveInput;
  dispose: () => Promise<void>;
};

async function prepareAudioSaveInput(
  audioSource: AudioSourceChoice,
  fileSource: FileSource
): Promise<PreparedInput> {
  if (audioSource === 'assetAudioFile') {
    return {
      input: fileSource,
      dispose: async () => {},
    };
  }

  if (audioSource === 'offlineAudioBuffer') {
    const ref = await createOfflineAudioBufferFromFile(fileSource, {
      forceMono: true,
    });
    return {
      input: ref.bufferId,
      dispose: async () => {
        await releasePipelineAudioBuffer(ref.bufferId).catch(() => {});
      },
    };
  }

  const live = await createEmptyLiveAudioBuffer({
    sampleRate: 16000,
    channelCount: 1,
  });
  let ingest: Awaited<ReturnType<typeof ingestFileToLiveAudioBuffer>> | null =
    null;
  try {
    ingest = await ingestFileToLiveAudioBuffer(live.bufferId, fileSource, {
      forceMono: true,
      autoFinalize: false,
    });
    await ingest.done;
    await finalizeLiveAudioBuffer(live.bufferId);
  } catch (e) {
    ingest?.cancel();
    await releasePipelineAudioBuffer(live.bufferId).catch(() => {});
    throw e;
  }

  return {
    input: live.bufferId,
    dispose: async () => {
      await releasePipelineAudioBuffer(live.bufferId).catch(() => {});
    },
  };
}

async function saveViaStagingAndSaveDocuments(
  input: PreparedInput['input'],
  format: AudioOutputFormat,
  outputSampleRateHz: number
): Promise<ResolvedFileRef> {
  const stagingRel = `fileio-staging/fileio-temp-${Date.now()}.${format}`;
  const stagingDest: FileDestination = {
    kind: 'app',
    base: 'cache',
    path: stagingRel,
  };
  const saveOptions =
    outputSampleRateHz > 0 ? { outputSampleRateHz } : undefined;

  const staged = await saveAudioAsFile(input, stagingDest, format, saveOptions);
  if (staged.kind !== 'fs') {
    throw new Error(
      'Expected a filesystem path from app cache staging; got content URI.'
    );
  }
  const fsPath = staged.path;

  const sourceUri = encodeURI(
    fsPath.startsWith('file://') ? fsPath : `file://${fsPath}`
  );

  const outName = exportFilename(format);
  try {
    const responses = await saveDocuments({
      sourceUris: [sourceUri],
      mimeType: mimeTypeForFormat(format),
      fileName: outName,
    });
    const first = responses[0];
    if (first?.error) {
      throw new Error(first.error);
    }
    const uri = first?.uri?.trim();
    if (!uri) {
      throw new Error('Save dialog did not return a target URI.');
    }
    return uri.startsWith('content://')
      ? { kind: 'contentUri', uri }
      : { kind: 'fs', path: decodeURI(uri.replace(/^file:\/\//, '')) };
  } finally {
    await unlink(fsPath).catch(() => {});
  }
}

export async function runFileioProbe(
  input: FileioInputSource
): Promise<FileioProbeResult> {
  const bundledPath = input.bundledPath;
  try {
    const probe = await probeAudioFileDuration(input.fileSource);
    if (!probe) {
      return {
        status: 'error',
        message: formatProbeNullError(input, bundledPath),
      };
    }
    const detail = [
      `Duration: ${probe.durationMs.toFixed(1)} ms`,
      `Exact: ${probe.isExact ? 'yes' : 'no'}`,
      `Input: ${input.label}`,
      describeFileSource(input.fileSource),
    ].join('\n');
    return {
      status: 'success',
      durationMs: probe.durationMs,
      isExact: probe.isExact,
      detail,
    };
  } catch (e) {
    return {
      status: 'error',
      message: formatFileioNativeError(input.fileSource, bundledPath, e),
    };
  }
}

export async function runFileioDecode(
  input: FileioInputSource
): Promise<FileioDecodeResult> {
  const bundledPath = input.bundledPath;
  try {
    const ref = await createOfflineAudioBufferFromFile(input.fileSource, {
      forceMono: true,
    });
    const { info, bufferId } = ref;
    await releasePipelineAudioBuffer(bufferId).catch(() => {});
    const detail = [
      `bufferId: ${String(bufferId)}`,
      `sampleRate: ${info.sampleRate} Hz`,
      `channels: ${info.channelCount}`,
      `samples: ${info.numSamples}`,
      `duration: ${info.durationMs.toFixed(1)} ms`,
      `storage: ${info.storageKind ?? 'ram'}`,
      `Input: ${input.label}`,
      describeFileSource(input.fileSource),
    ].join('\n');
    return {
      status: 'success',
      bufferId: String(bufferId),
      sampleRate: info.sampleRate,
      channelCount: info.channelCount,
      numSamples: info.numSamples,
      durationMs: info.durationMs,
      detail,
    };
  } catch (e) {
    return {
      status: 'error',
      message: formatFileioNativeError(input.fileSource, bundledPath, e),
    };
  }
}

export async function runFileioCopy(
  input: FileioCopyInput
): Promise<FileioCopyResult> {
  let prepared: PreparedInput | null = null;
  const outputSampleRateHz =
    input.outputSampleRateHz ?? defaultSampleRateForFormat(input.outputFormat);
  const saveOptions =
    outputSampleRateHz > 0 ? { outputSampleRateHz } : undefined;

  try {
    prepared = await prepareAudioSaveInput(
      input.audioSource,
      input.inputSource
    );

    let resolved: ResolvedFileRef;

    switch (input.destinationKind) {
      case 'fs':
      case 'app': {
        const dest = await fixedDestinationForKind(
          input.destinationKind,
          input.outputFormat
        );
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          input.outputFormat,
          saveOptions
        );
        break;
      }
      case 'contentTree': {
        const dest = await pickContentTreeDestination(input.outputFormat);
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          input.outputFormat,
          saveOptions
        );
        break;
      }
      case 'contentUri': {
        if (Platform.OS === 'ios') {
          resolved = await saveAudioAsFile(
            prepared.input,
            { kind: 'contentUri', uri: 'content://unsupported-on-ios' },
            input.outputFormat,
            saveOptions
          );
          break;
        }
        resolved = await saveViaStagingAndSaveDocuments(
          prepared.input,
          input.outputFormat,
          outputSampleRateHz
        );
        break;
      }
      case 'securityScoped': {
        const dest = await pickSecurityScopedDestination();
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          input.outputFormat,
          saveOptions
        );
        break;
      }
    }

    const location = formatResolvedLocation(resolved);
    const detail = [
      `Output: ${location}`,
      `Format: ${input.outputFormat}`,
      outputSampleRateHz > 0
        ? `Sample rate: ${outputSampleRateHz} Hz`
        : 'Sample rate: source',
      `Encode source card: ${input.audioSource}`,
      `File input: ${input.inputLabel}`,
      describeFileSource(input.inputSource),
    ].join('\n');

    return { status: 'success', resolved, detail };
  } catch (e) {
    if (isPickCanceled(e)) {
      return { status: 'canceled' };
    }
    const bundledPath =
      input.inputSource.kind === 'app' && input.inputSource.base === 'files'
        ? input.inputSource.path
        : undefined;
    const message = formatFileioNativeError(input.inputSource, bundledPath, e);
    return { status: 'error', message };
  } finally {
    await prepared?.dispose();
  }
}
