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
  probeAudioFileContainer,
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
import {
  createOfflineVideoBufferFromFile,
  exportVideo,
  exportVideoFrame,
  probeVideoFileContainer,
  probeVideoFileDuration,
  releaseVideoBuffer,
  type VideoExportContainer,
} from 'react-native-sherpa-onnx/videobuffer';

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
export { fileioSampleMedia } from './fileioInputChannels';

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

export const FILEIO_VIDEO_OUTPUT_FORMATS: VideoExportContainer[] = [
  'mp4',
  'mov',
  'mkv',
  'webm',
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
  | {
      status: 'success';
      media: 'audio' | 'video';
      durationMs?: number;
      durationUs?: number;
      isExact?: boolean;
      inputFormatName?: string;
      codecName?: string;
      detail: string;
      summary: string;
    }
  | { status: 'error'; message: string };

export type FileioDecodeResult =
  | {
      status: 'success';
      media: 'audio' | 'video';
      bufferId: string;
      durationMs?: number;
      durationUs?: number;
      detail: string;
      summary: string;
    }
  | { status: 'error'; message: string };

export type FileioVideoEncodeInput = {
  destinationKind: FileDestination['kind'];
  inputSource: FileSource;
  inputLabel: string;
  outputFormat: VideoExportContainer;
};

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

export function mimeTypeForVideoFormat(format: VideoExportContainer): string {
  switch (format) {
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
  }
}

function exportFilename(ext: string, prefix = 'fileio-copy'): string {
  return `${prefix}-${Date.now()}.${ext}`;
}

function isBundledTestPath(rel: string | undefined): rel is string {
  return (
    !!rel &&
    (rel.startsWith('test_codec/') ||
      rel.startsWith('test_wavs/') ||
      rel.startsWith('test_videos/'))
  );
}

function looksLikeMissingBundledAsset(nativeMessage: string): boolean {
  const lower = nativeMessage.toLowerCase();
  return (
    lower.includes('apk asset not found') ||
    lower.includes('probe_open_failed') ||
    lower.includes('probe_not_found') ||
    lower.includes('source file not found') ||
    lower.includes('cannot open file') ||
    lower.includes('video_ffmpeg_disabled') ||
    lower.includes('video_file_corrupt')
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
    return `Probe returned no metadata: ${bundledPath}`;
  }
  return [
    `Probe returned no metadata for: ${input.label}`,
    describeFileSource(input.fileSource),
  ].join('\n');
}

function isVideoBundledPath(path: string | undefined): boolean {
  return !!path && path.startsWith('test_videos/');
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
  filename: string,
  mimeType: string
): Promise<FileDestination> {
  const picked = await pickDirectory({ requestLongTermAccess: false });
  const uri = picked.uri?.trim();
  if (!uri) {
    throw new Error('Folder picker did not return a URI.');
  }
  return buildContentTreeDestination(uri, filename, mimeType);
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
  filename: string
): Promise<FileDestination> {
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

async function runAudioProbe(
  input: FileioInputSource
): Promise<FileioProbeResult> {
  const duration = await probeAudioFileDuration(input.fileSource);
  const container = await probeAudioFileContainer(input.fileSource);
  if (!duration && !container) {
    return {
      status: 'error',
      message: formatProbeNullError(input, input.bundledPath),
    };
  }
  const lines = ['Media: audio'];
  if (duration) {
    lines.push(
      `Duration: ${duration.durationMs.toFixed(1)} ms`,
      `Exact: ${duration.isExact ? 'yes' : 'no'}`
    );
  }
  if (container) {
    lines.push(
      `Container: ${container.inputFormatName}`,
      `Codec: ${container.codecName}`
    );
  }
  lines.push(`Input: ${input.label}`, describeFileSource(input.fileSource));
  const summaryParts = [
    duration ? `${duration.durationMs.toFixed(0)} ms` : null,
    container ? `${container.inputFormatName}/${container.codecName}` : null,
  ].filter(Boolean);
  return {
    status: 'success',
    media: 'audio',
    durationMs: duration?.durationMs,
    isExact: duration?.isExact,
    inputFormatName: container?.inputFormatName,
    codecName: container?.codecName,
    detail: lines.join('\n'),
    summary: summaryParts.join(', ') || 'ok',
  };
}

async function runVideoProbe(
  input: FileioInputSource
): Promise<FileioProbeResult> {
  const duration = await probeVideoFileDuration(input.fileSource);
  const container = await probeVideoFileContainer(input.fileSource);
  if (!duration && !container) {
    return {
      status: 'error',
      message: formatProbeNullError(input, input.bundledPath),
    };
  }
  const lines = ['Media: video'];
  if (duration) {
    lines.push(
      `Duration: ${(duration.durationUs / 1000).toFixed(1)} ms (${
        duration.durationUs
      } µs)`,
      `Exact: ${duration.isExact ? 'yes' : 'no'}`
    );
  }
  if (container) {
    lines.push(
      `Container: ${container.inputFormatName}`,
      `Video codec: ${container.codecName}`,
      `Coded size: ${container.codedWidth}×${container.codedHeight}`
    );
    if (container.audioCodecName) {
      lines.push(`Audio codec: ${container.audioCodecName}`);
    }
  }
  lines.push(`Input: ${input.label}`, describeFileSource(input.fileSource));
  const summaryParts = [
    duration ? `${(duration.durationUs / 1000).toFixed(0)} ms` : null,
    container ? `${container.inputFormatName}/${container.codecName}` : null,
  ].filter(Boolean);
  return {
    status: 'success',
    media: 'video',
    durationUs: duration?.durationUs,
    durationMs: duration ? duration.durationUs / 1000 : undefined,
    isExact: duration?.isExact,
    inputFormatName: container?.inputFormatName,
    codecName: container?.codecName,
    detail: lines.join('\n'),
    summary: summaryParts.join(', ') || 'ok',
  };
}

export async function runFileioProbe(
  input: FileioInputSource
): Promise<FileioProbeResult> {
  try {
    if (isVideoBundledPath(input.bundledPath)) {
      return await runVideoProbe(input);
    }
    if (input.bundledPath) {
      return await runAudioProbe(input);
    }
    const video = await runVideoProbe(input);
    if (video.status === 'success') {
      return video;
    }
    return await runAudioProbe(input);
  } catch (e) {
    return {
      status: 'error',
      message: formatFileioNativeError(input.fileSource, input.bundledPath, e),
    };
  }
}

async function runAudioDecode(
  input: FileioInputSource
): Promise<FileioDecodeResult> {
  const ref = await createOfflineAudioBufferFromFile(input.fileSource, {
    forceMono: true,
  });
  const { info, bufferId } = ref;
  await releasePipelineAudioBuffer(bufferId).catch(() => {});
  const detail = [
    'Media: audio',
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
    media: 'audio',
    bufferId: String(bufferId),
    durationMs: info.durationMs,
    detail,
    summary: `${info.durationMs.toFixed(0)} ms, ${info.sampleRate} Hz`,
  };
}

async function runVideoDecode(
  input: FileioInputSource
): Promise<FileioDecodeResult> {
  const video = await createOfflineVideoBufferFromFile(input.fileSource);
  const frameRel = `SherpaOnnxFileIO/decode-frame-${Date.now()}.jpg`;
  try {
    const ptsUs = video.info.seekableStartUs ?? 0;
    const still = await exportVideoFrame(
      video,
      ptsUs,
      { kind: 'app', base: 'cache', path: frameRel },
      { format: 'jpeg', maxSide: 256 }
    );
    if (still.kind === 'fs') {
      await unlink(still.path).catch(() => {});
    }
    const durationUs =
      (video.info.seekableEndUs ?? 0) - (video.info.seekableStartUs ?? 0);
    const detail = [
      'Media: video',
      `bufferId: ${String(video.bufferId)}`,
      `kind: ${video.info.kind}`,
      `frames: ${video.info.frameCount}`,
      `seekable: ${video.info.seekableStartUs ?? 0}–${
        video.info.seekableEndUs ?? 0
      } µs`,
      `audio: ${video.info.audio?.codec ?? 'none'}`,
      `decoded frame at ${ptsUs} µs (jpeg, discarded)`,
      `Input: ${input.label}`,
      describeFileSource(input.fileSource),
    ].join('\n');
    return {
      status: 'success',
      media: 'video',
      bufferId: String(video.bufferId),
      durationUs,
      durationMs: durationUs / 1000,
      detail,
      summary: `${video.info.frameCount} frames, frame@${ptsUs}µs`,
    };
  } finally {
    await releaseVideoBuffer(video).catch(() => {});
  }
}

export async function runFileioDecode(
  input: FileioInputSource
): Promise<FileioDecodeResult> {
  try {
    if (isVideoBundledPath(input.bundledPath)) {
      return await runVideoDecode(input);
    }
    if (input.bundledPath) {
      return await runAudioDecode(input);
    }
    try {
      return await runVideoDecode(input);
    } catch {
      return await runAudioDecode(input);
    }
  } catch (e) {
    return {
      status: 'error',
      message: formatFileioNativeError(input.fileSource, input.bundledPath, e),
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
          exportFilename(input.outputFormat)
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
        const dest = await pickContentTreeDestination(
          exportFilename(input.outputFormat),
          mimeTypeForFormat(input.outputFormat)
        );
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

export async function runFileioVideoEncode(
  input: FileioVideoEncodeInput
): Promise<FileioCopyResult> {
  let video: Awaited<
    ReturnType<typeof createOfflineVideoBufferFromFile>
  > | null = null;
  const filename = exportFilename(input.outputFormat, 'fileio-video');
  const mime = mimeTypeForVideoFormat(input.outputFormat);
  try {
    video = await createOfflineVideoBufferFromFile(input.inputSource);

    let dest: FileDestination;
    switch (input.destinationKind) {
      case 'fs':
      case 'app':
        dest = await fixedDestinationForKind(input.destinationKind, filename);
        break;
      case 'contentTree':
        dest = await pickContentTreeDestination(filename, mime);
        break;
      case 'contentUri': {
        if (Platform.OS === 'ios') {
          dest = { kind: 'contentUri', uri: 'content://unsupported-on-ios' };
          break;
        }
        dest = {
          kind: 'app',
          base: 'cache',
          path: `SherpaOnnxFileIO/staging/${filename}`,
        };
        const staged = await exportVideo(video, dest, input.outputFormat);
        if (staged.kind !== 'fs') {
          throw new Error(
            'Expected a filesystem path from app cache staging; got content URI.'
          );
        }
        const sourceUri = encodeURI(
          staged.path.startsWith('file://')
            ? staged.path
            : `file://${staged.path}`
        );
        try {
          const responses = await saveDocuments({
            sourceUris: [sourceUri],
            mimeType: mime,
            fileName: filename,
          });
          const first = responses[0];
          if (first?.error) {
            throw new Error(first.error);
          }
          const uri = first?.uri?.trim();
          if (!uri) {
            throw new Error('Save dialog did not return a target URI.');
          }
          const resolved: ResolvedFileRef = uri.startsWith('content://')
            ? { kind: 'contentUri', uri }
            : { kind: 'fs', path: decodeURI(uri.replace(/^file:\/\//, '')) };
          return {
            status: 'success',
            resolved,
            detail: [
              `Output: ${formatResolvedLocation(resolved)}`,
              `Format: ${input.outputFormat}`,
              'Video encode: exportVideo (H.264)',
              `File input: ${input.inputLabel}`,
              describeFileSource(input.inputSource),
            ].join('\n'),
          };
        } finally {
          await unlink(staged.path).catch(() => {});
        }
      }
      case 'securityScoped':
        dest = await pickSecurityScopedDestination();
        break;
    }

    const resolved = await exportVideo(video, dest, input.outputFormat);
    return {
      status: 'success',
      resolved,
      detail: [
        `Output: ${formatResolvedLocation(resolved)}`,
        `Format: ${input.outputFormat}`,
        'Video encode: exportVideo (H.264)',
        `File input: ${input.inputLabel}`,
        describeFileSource(input.inputSource),
      ].join('\n'),
    };
  } catch (e) {
    if (isPickCanceled(e)) {
      return { status: 'canceled' };
    }
    return {
      status: 'error',
      message: formatFileioNativeError(
        input.inputSource,
        input.inputSource.kind === 'app' ? input.inputSource.path : undefined,
        e
      ),
    };
  } finally {
    if (video) {
      await releaseVideoBuffer(video).catch(() => {});
    }
  }
}
