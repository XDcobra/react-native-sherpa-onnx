/**
 * Pipeline video buffers — public API for react-native-sherpa-onnx/videobuffer.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import {
  exportOfflineImageBufferFrame,
  releaseOfflineImageBuffer,
} from '../imagebuffer';
import { assertFileDestinationSupportedOnPlatform } from '../fileio/platformValidation';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';
import type {
  LiveAudioBufferRef,
  OfflineAudioBufferRef,
} from '../audiobuffer/types';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
} from '../audiobuffer';
import type {
  ConfigureVideoBufferOptions,
  CreateEmptyLiveVideoBufferOptions,
  CreateOfflineAudioFromVideoOptions,
  CreateOfflineImageFromVideoOptions,
  ExportVideoFrameOptions,
  ExportVideoOptions,
  IngestFileToLiveOptions,
  LiveVideoBufferEvent,
  LiveVideoBufferFinishedRef,
  LiveVideoBufferHandleFinished,
  LiveVideoBufferHandleRecording,
  LiveVideoBufferIdSource,
  LiveVideoBufferInfo,
  LiveVideoBufferRef,
  OfflineVideoBufferHandle,
  OfflineVideoBufferIdSource,
  OfflineVideoBufferInfo,
  OfflineVideoBufferRef,
  PipelineVideoBufferIdSource,
  PipelineVideoBufferInfo,
  VideoAudioExtractResult,
  VideoExportCodec,
  VideoExportContainer,
  VideoFileContainerProbe,
  VideoFileDurationProbe,
} from './types';

let extractOpId = 0;
let exportOpId = 0;

const VIDEO_EXPORT_FORMATS: readonly VideoExportContainer[] = [
  'mp4',
  'mov',
  'mkv',
  'webm',
];
const VIDEO_EXPORT_CODECS: readonly VideoExportCodec[] = ['h264', 'hevc'];

function parseResolvedFileRef(result: {
  outputKind: string;
  outputPath: string;
}): ResolvedFileRef {
  if (result.outputKind === 'contentUri') {
    return { kind: 'contentUri', uri: result.outputPath };
  }
  return { kind: 'fs', path: result.outputPath };
}

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const OFFLINE_ID =
  /^vid_off_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LIVE_ID =
  /^vid_live_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asStringId(source: unknown, label: string): string {
  if (typeof source === 'string') {
    return source;
  }
  if (source && typeof source === 'object') {
    if (
      'bufferId' in source &&
      typeof (source as { bufferId: unknown }).bufferId === 'string'
    ) {
      return (source as { bufferId: string }).bufferId;
    }
    if ('info' in source) {
      const info = (source as { info?: { bufferId?: unknown } }).info;
      if (info && typeof info.bufferId === 'string') {
        return info.bufferId;
      }
    }
  }
  throw new Error(`VIDEO_INVALID_ARGUMENT: invalid ${label}`);
}

export function resolveOfflineVideoBufferId(
  source: OfflineVideoBufferIdSource
): string {
  const id = asStringId(source, 'offline video buffer');
  if (!OFFLINE_ID.test(id) && !LIVE_ID.test(id)) {
    throw new Error(`VIDEO_INVALID_ARGUMENT: malformed video buffer id: ${id}`);
  }
  return id;
}

export function resolveLiveVideoBufferId(
  source: LiveVideoBufferIdSource
): string {
  const id = asStringId(source, 'live video buffer');
  if (!LIVE_ID.test(id)) {
    throw new Error(`VIDEO_INVALID_ARGUMENT: malformed live video id: ${id}`);
  }
  return id;
}

export function resolvePipelineVideoBufferId(
  source: PipelineVideoBufferIdSource
): string {
  const id = asStringId(source, 'pipeline video buffer');
  if (!OFFLINE_ID.test(id) && !LIVE_ID.test(id)) {
    throw new Error(`VIDEO_INVALID_ARGUMENT: malformed video buffer id: ${id}`);
  }
  return id;
}

function mapAudio(raw: {
  audioCodec?: string;
  audioDecodable?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  audioStartUs?: number;
  audioDurationUs?: number;
}): import('./types').VideoAudioTrackInfo | null {
  if (!raw.audioCodec) return null;
  return {
    codec: raw.audioCodec,
    decodable: raw.audioDecodable === 'true',
    sampleRate: raw.audioSampleRate ?? 0,
    channels: raw.audioChannels ?? 0,
    startMs: (raw.audioStartUs ?? 0) / 1000,
    durationMs: (raw.audioDurationUs ?? 0) / 1000,
  };
}

function mapInfo(raw: {
  bufferId: string;
  kind: string;
  state: string;
  frameCount: number;
  liveEdgeUs?: number;
  totalFramesWritten?: number;
  ringEvictedFrames?: number;
  hasActiveSpool?: string;
  seekableStartUs?: number;
  seekableEndUs?: number;
  audioCodec?: string;
  audioDecodable?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  audioStartUs?: number;
  audioDurationUs?: number;
  errorCode?: string;
  errorMessage?: string;
}): PipelineVideoBufferInfo {
  if (raw.errorCode) {
    throw new Error(`${raw.errorCode}: ${raw.errorMessage ?? ''}`);
  }
  const audio = mapAudio(raw);
  if (raw.kind === 'liveVideoBuffer') {
    const info: LiveVideoBufferInfo = {
      bufferId: raw.bufferId,
      kind: 'liveVideoBuffer',
      state: raw.state === 'finished' ? 'finished' : 'recording',
      frameCount: raw.frameCount ?? 0,
      totalFramesWritten: raw.totalFramesWritten ?? 0,
      ringEvictedFrames: raw.ringEvictedFrames ?? 0,
      hasActiveSpool: raw.hasActiveSpool === 'true',
      liveEdgeUs: raw.liveEdgeUs,
      seekableStartUs: raw.seekableStartUs,
      seekableEndUs: raw.seekableEndUs,
      audio,
    };
    return info;
  }
  const info: OfflineVideoBufferInfo = {
    bufferId: raw.bufferId,
    kind: 'offlineVideoBuffer',
    state: 'immutable',
    frameCount: raw.frameCount ?? 0,
    seekableStartUs: raw.seekableStartUs,
    seekableEndUs: raw.seekableEndUs,
    audio,
  };
  return info;
}

function assertFileSource(source: FileSource): void {
  if (
    !source ||
    typeof source !== 'object' ||
    typeof (source as FileSource).kind !== 'string'
  ) {
    throw new Error('VIDEO_INVALID_ARGUMENT: source must be a FileSource');
  }
}

export async function probeVideoFileDuration(
  source: FileSource
): Promise<VideoFileDurationProbe | null> {
  assertFileSource(source);
  try {
    const result = await getNative().probeVideoFileDuration(source as Object);
    if (
      !result ||
      typeof result.durationUs !== 'number' ||
      !Number.isFinite(result.durationUs) ||
      result.durationUs <= 0
    ) {
      return null;
    }
    return {
      durationUs: result.durationUs,
      isExact: Boolean(result.isExact),
    };
  } catch {
    return null;
  }
}

export async function probeVideoFileContainer(
  source: FileSource
): Promise<VideoFileContainerProbe | null> {
  assertFileSource(source);
  try {
    const result = await getNative().probeVideoFileContainer(source as Object);
    const inputFormatName = result?.inputFormatName?.trim();
    const codecName = result?.codecName?.trim();
    if (!inputFormatName || !codecName) {
      return null;
    }
    const codedWidth =
      typeof result.codedWidth === 'number' ? result.codedWidth : 0;
    const codedHeight =
      typeof result.codedHeight === 'number' ? result.codedHeight : 0;
    const audio = result.audioCodecName?.trim();
    const probe: VideoFileContainerProbe = {
      inputFormatName,
      codecName,
      codedWidth,
      codedHeight,
    };
    if (audio) {
      probe.audioCodecName = audio;
    }
    if (__DEV__) {
      console.log(
        '[SherpaOnnx:video] probeContainer',
        probe.inputFormatName,
        probe.codecName,
        `${probe.codedWidth}x${probe.codedHeight}`
      );
    }
    return probe;
  } catch {
    return null;
  }
}

export async function createOfflineVideoBufferFromFile(
  source: FileSource
): Promise<OfflineVideoBufferRef> {
  assertFileSource(source);
  const raw = await getNative().createOfflineVideoBufferFromFile(
    source as Object,
    {}
  );
  const info = mapInfo(raw) as OfflineVideoBufferInfo;
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:video] createOfflineFromFile',
      info.bufferId,
      'kind=',
      source.kind
    );
  }
  return {
    info,
    bufferId: info.bufferId as OfflineVideoBufferHandle,
  };
}

export async function createEmptyLiveVideoBuffer(
  options?: CreateEmptyLiveVideoBufferOptions
): Promise<LiveVideoBufferRef> {
  let retentionMode = 0;
  let path: string | undefined;
  const ret = options?.retention;
  if (ret === 'none') {
    retentionMode = 1;
  } else if (ret && typeof ret === 'object' && ret.mode === 'maxSeconds') {
    retentionMode = 2;
  } else if (ret && typeof ret === 'object' && ret.mode === 'path') {
    retentionMode = 3;
    path = ret.directory;
  }
  const raw = await getNative().createEmptyLiveVideoBuffer({
    ringSeconds: options?.ringSeconds ?? 10,
    retentionMode,
    retentionPath: path,
  });
  const info = mapInfo(raw) as LiveVideoBufferInfo;
  return {
    info,
    bufferId: info.bufferId as LiveVideoBufferHandleRecording,
    unsubscribeEvents: () => {},
  };
}

export async function ingestFileToLiveVideoBuffer(
  source: FileSource,
  live: LiveVideoBufferIdSource,
  options?: IngestFileToLiveOptions
): Promise<LiveVideoBufferInfo> {
  assertFileSource(source);
  const id = resolveLiveVideoBufferId(live);
  const raw = await getNative().ingestFileToLiveVideoBuffer(
    id,
    source as Object,
    {
      pacing: options?.pacing ?? 'asFast',
      includeAudio: options?.includeAudio ?? true,
    }
  );
  const info = mapInfo(raw) as LiveVideoBufferInfo;
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:video] ingestFileToLive',
      id,
      'kind=',
      source.kind
    );
  }
  return info;
}

export async function finalizeLiveVideoBuffer(
  live: LiveVideoBufferIdSource
): Promise<LiveVideoBufferFinishedRef> {
  const id = resolveLiveVideoBufferId(live);
  const raw = await getNative().finalizeLiveVideoBuffer(id);
  const info = mapInfo(raw) as LiveVideoBufferInfo;
  return {
    bufferId: info.bufferId as LiveVideoBufferHandleFinished,
    info,
  };
}

export async function getVideoBufferInfo(
  source: PipelineVideoBufferIdSource
): Promise<PipelineVideoBufferInfo> {
  const id = resolvePipelineVideoBufferId(source);
  return mapInfo(await getNative().getVideoBufferInfo(id));
}

export async function getVideoKeyframeTimes(
  source: PipelineVideoBufferIdSource,
  range: { fromUs: number; toUs: number },
  maxCount = 64
): Promise<number[]> {
  const id = resolvePipelineVideoBufferId(source);
  return getNative().getVideoKeyframeTimes(
    id,
    range.fromUs,
    range.toUs,
    maxCount
  );
}

export async function releaseVideoBuffer(
  source: PipelineVideoBufferIdSource
): Promise<void> {
  const id = resolvePipelineVideoBufferId(source);
  await getNative().releaseVideoBuffer(id);
}

export async function createOfflineImageBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineImageFromVideoOptions
): Promise<{ imageBufferId: string; frameCount: number }> {
  const id = resolveOfflineVideoBufferId(video);
  const sampling =
    options?.sampling === 'fps'
      ? 1
      : options?.sampling === 'keyframes'
      ? 3
      : options?.sampling === 'uniform'
      ? 4
      : options?.sampling === 'times' ||
        (options?.timesUs && options.timesUs.length > 0)
      ? 5
      : 0;
  if (__DEV__) {
    console.log(
      '[SherpaOnnx:video] createOfflineImageBufferFromVideo',
      id,
      options?.sampling ?? 'all',
      options?.fps ?? 0,
      options?.maxSide ?? 0
    );
  }
  const raw = await getNative().createOfflineImageBufferFromVideo(id, {
    sampling,
    uniformCount: options?.uniformCount ?? 0,
    fps: options?.fps ?? 0,
    maxSide: options?.maxSide ?? 0,
    timesUs: options?.timesUs,
  });
  if (raw.errorCode) {
    if (__DEV__) {
      console.log(
        '[SherpaOnnx:video] createOfflineImageBufferFromVideo fail',
        raw.errorCode,
        raw.errorMessage
      );
    }
    throw new Error(`${raw.errorCode}: ${raw.errorMessage ?? ''}`);
  }
  return {
    imageBufferId: raw.imageBufferId ?? '',
    frameCount: raw.frameCount ?? 0,
  };
}

export function subscribeLiveVideoBufferEvents(
  live: LiveVideoBufferIdSource,
  onEvent: (event: LiveVideoBufferEvent) => void
): () => void {
  const id = resolveLiveVideoBufferId(live);
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  const sub = emitter.addListener(
    'SherpaOnnxVideoEvent',
    (raw: {
      type?: string;
      liveBufferId?: string;
      frameCount?: number;
      totalFramesWritten?: number;
      liveEdgeUs?: number;
    }) => {
      if (!raw || raw.liveBufferId !== id) return;
      onEvent({
        type: (raw.type as LiveVideoBufferEvent['type']) ?? 'packetsAppended',
        liveBufferId: raw.liveBufferId,
        frameCount: raw.frameCount,
        totalFramesWritten: raw.totalFramesWritten,
        liveEdgeUs: raw.liveEdgeUs,
      });
    }
  );
  return () => sub.remove();
}

function assertBudgetLimit(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(
      `VIDEO_INVALID_ARGUMENT: decoderBudget.${field} must be an integer in [1, 4]`
    );
  }
}

export async function createOfflineAudioBufferFromVideo(
  video: OfflineVideoBufferIdSource,
  options?: CreateOfflineAudioFromVideoOptions
): Promise<VideoAudioExtractResult> {
  const id = resolveOfflineVideoBufferId(video);
  const targetSampleRateHz =
    options?.targetSampleRateHz === undefined
      ? 16000
      : options.targetSampleRateHz;
  if (
    typeof targetSampleRateHz !== 'number' ||
    !Number.isFinite(targetSampleRateHz) ||
    targetSampleRateHz < 0
  ) {
    throw new Error(
      'VIDEO_INVALID_ARGUMENT: targetSampleRateHz must be a finite number >= 0'
    );
  }
  let startUs = 0;
  let endUs = -1;
  if (options?.rangeMs) {
    const { startMs, endMs } = options.rangeMs;
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      throw new Error(
        'VIDEO_INVALID_ARGUMENT: rangeMs must have endMs > startMs'
      );
    }
    startUs = Math.round(startMs * 1000);
    endUs = Math.round(endMs * 1000);
  }
  const operationId = `vid_aud_${Date.now()}_${++extractOpId}`;
  let progressSubscription: { remove: () => void } | null = null;
  let abortHandler: (() => void) | null = null;
  try {
    if (options?.onProgress) {
      const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener(
        'decodeProgress',
        (event: any) => {
          if (event?.operationId === operationId) {
            onProgress({
              percent: event.percent ?? 0,
              decodedMs: event.framesDecoded ?? 0,
            });
          }
        }
      );
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        throw new Error('VIDEO_CANCELLED: Operation cancelled');
      }
      abortHandler = () => {
        getNative().cancelDecode(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }
    const raw = await getNative().createOfflineAudioBufferFromVideo(id, {
      startUs,
      endUs,
      targetSampleRateHz,
      operationId,
    });
    if (raw.errorCode) {
      throw new Error(`${raw.errorCode}: ${raw.errorMessage ?? ''}`);
    }
    const info = {
      bufferId: raw.bufferId ?? '',
      kind: 'offlinePcmBuffer' as const,
      state: 'immutable' as const,
      sampleRate: raw.sampleRate ?? 0,
      channelCount: raw.channelCount ?? 1,
      numSamples: raw.numSamples ?? 0,
      durationMs: raw.durationMs ?? 0,
      storageKind: raw.storageKind as 'ram' | 'mmap' | undefined,
    };
    const audio: OfflineAudioBufferRef = {
      info,
      bufferId: info.bufferId as OfflineAudioBufferRef['bufferId'],
    };
    return {
      audio,
      mediaStartMs: raw.mediaStartMs ?? 0,
      sourceCodec: raw.sourceCodec ?? '',
      sourceSampleRate: raw.sourceSampleRate ?? 0,
      sourceChannels: raw.sourceChannels ?? 0,
    };
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

export async function configureVideoBuffer(
  options?: ConfigureVideoBufferOptions
): Promise<void> {
  const cpu = options?.decoderBudget?.cpu;
  const display = options?.decoderBudget?.display;
  assertBudgetLimit(cpu, 'cpu');
  assertBudgetLimit(display, 'display');
  await getNative().configureVideoBuffer({
    decoderBudget:
      cpu !== undefined || display !== undefined
        ? {
            ...(cpu !== undefined ? { cpu } : {}),
            ...(display !== undefined ? { display } : {}),
          }
        : undefined,
  });
}

export async function createLiveAudioBufferFromLiveVideo(
  live: LiveVideoBufferIdSource,
  options?: {
    targetSampleRateHz?: number;
    windowSeconds?: number;
    startAt?: 'oldest' | 'liveEdge';
  }
): Promise<{
  audio: LiveAudioBufferRef;
  mediaStartMs: number;
  stop(): Promise<void>;
}> {
  const id = resolveLiveVideoBufferId(live);
  const target = options?.targetSampleRateHz ?? 16000;
  const audio = await createEmptyLiveAudioBuffer({
    sampleRate: target,
    channelCount: 1,
  });
  await getNative().startLiveVideoAudioTap(id, audio.bufferId, target);
  return {
    audio,
    mediaStartMs: 0,
    stop: async () => {
      await getNative().stopLiveVideoAudioTap(id);
      await finalizeLiveAudioBuffer(audio.bufferId);
    },
  };
}

export async function exportVideo(
  video: OfflineVideoBufferIdSource,
  output: FileDestination,
  format: VideoExportContainer,
  options?: ExportVideoOptions
): Promise<ResolvedFileRef> {
  const id = resolveOfflineVideoBufferId(video);
  if (!(VIDEO_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(
      `VIDEO_INVALID_ARGUMENT: format must be one of ${VIDEO_EXPORT_FORMATS.join(
        ', '
      )}`
    );
  }
  const codec: VideoExportCodec = options?.codec ?? 'h264';
  if (!(VIDEO_EXPORT_CODECS as readonly string[]).includes(codec)) {
    throw new Error(
      `VIDEO_INVALID_ARGUMENT: codec must be one of ${VIDEO_EXPORT_CODECS.join(
        ', '
      )}`
    );
  }
  const bitrate = options?.bitrate ?? 2_000_000;
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    throw new Error(
      'VIDEO_INVALID_ARGUMENT: bitrate must be a finite number > 0'
    );
  }
  const fromUs = options?.fromUs;
  const toUs = options?.toUs;
  if (fromUs !== undefined && (!Number.isFinite(fromUs) || fromUs < 0)) {
    throw new Error(
      'VIDEO_INVALID_ARGUMENT: fromUs must be a finite number >= 0'
    );
  }
  if (toUs !== undefined && (!Number.isFinite(toUs) || toUs < 0)) {
    throw new Error(
      'VIDEO_INVALID_ARGUMENT: toUs must be a finite number >= 0'
    );
  }
  if (fromUs !== undefined && toUs !== undefined && toUs <= fromUs) {
    throw new Error('VIDEO_INVALID_ARGUMENT: toUs must be greater than fromUs');
  }
  const maxSide = options?.maxSide ?? 0;
  if (!Number.isFinite(maxSide) || maxSide < 0) {
    throw new Error(
      'VIDEO_INVALID_ARGUMENT: maxSide must be a finite number >= 0'
    );
  }
  assertFileDestinationSupportedOnPlatform(output);

  const operationId = `vid_exp_${Date.now()}_${++exportOpId}`;
  let progressSubscription: { remove: () => void } | null = null;
  let abortHandler: (() => void) | null = null;
  try {
    if (options?.onProgress) {
      const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
      const onProgress = options.onProgress;
      progressSubscription = emitter.addListener(
        'decodeProgress',
        (event: any) => {
          if (event?.operationId === operationId) {
            onProgress({
              percent: event.percent ?? 0,
              encodedUs: event.encodedUs ?? 0,
            });
          }
        }
      );
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        throw new Error('VIDEO_CANCELLED: Operation cancelled');
      }
      abortHandler = () => {
        getNative().cancelDecode(operationId);
      };
      options.signal.addEventListener('abort', abortHandler);
    }
    const result = await getNative().exportVideo(
      id,
      output as unknown as Object,
      format,
      {
        codec,
        bitrate: Math.trunc(bitrate),
        fromUs: fromUs !== undefined ? Math.trunc(fromUs) : undefined,
        toUs: toUs !== undefined ? Math.trunc(toUs) : undefined,
        maxSide: Math.trunc(maxSide),
        operationId,
      }
    );
    if (__DEV__) {
      console.log('[SherpaOnnx:video] exportVideo', id, format, codec, result);
    }
    return parseResolvedFileRef(result);
  } finally {
    progressSubscription?.remove();
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

export async function exportVideoFrame(
  video: OfflineVideoBufferIdSource,
  ptsUs: number,
  destination: FileDestination,
  options?: ExportVideoFrameOptions
): Promise<ResolvedFileRef> {
  const img = await createOfflineImageBufferFromVideo(video, {
    sampling: 'times',
    timesUs: [ptsUs],
    maxSide: options?.maxSide,
  });
  try {
    return await exportOfflineImageBufferFrame(
      img.imageBufferId,
      0,
      destination,
      {
        format: options?.format ?? 'jpeg',
        quality: options?.quality,
        maxSide: options?.maxSide,
      }
    );
  } finally {
    await releaseOfflineImageBuffer(img.imageBufferId);
  }
}

export type {
  ConfigureVideoBufferOptions,
  CreateEmptyLiveVideoBufferOptions,
  CreateOfflineAudioFromVideoOptions,
  CreateOfflineImageFromVideoOptions,
  ExportVideoFrameOptions,
  ExportVideoOptions,
  IngestFileToLiveOptions,
  LiveVideoBufferEvent,
  LiveVideoBufferEventType,
  LiveVideoBufferFinishedRef,
  LiveVideoBufferHandle,
  LiveVideoBufferHandleFinished,
  LiveVideoBufferHandleRecording,
  LiveVideoBufferIdSource,
  LiveVideoBufferInfo,
  LiveVideoBufferRef,
  OfflineVideoBufferHandle,
  OfflineVideoBufferIdSource,
  OfflineVideoBufferInfo,
  OfflineVideoBufferRef,
  PipelineVideoBufferIdSource,
  PipelineVideoBufferInfo,
  PipelineVideoBufferKind,
  VideoAudioExtractResult,
  VideoAudioTrackInfo,
  VideoDecoderBudget,
  VideoExportCodec,
  VideoExportContainer,
  VideoFileContainerProbe,
  VideoFileDurationProbe,
  VideoRetention,
} from './types';
