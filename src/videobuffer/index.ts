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
import type { FileDestination, ResolvedFileRef } from '../fileio/types';
import type {
  CreateEmptyLiveVideoBufferOptions,
  CreateOfflineImageFromVideoOptions,
  ExportVideoFrameOptions,
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
} from './types';

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
  errorCode?: string;
  errorMessage?: string;
}): PipelineVideoBufferInfo {
  if (raw.errorCode) {
    throw new Error(`${raw.errorCode}: ${raw.errorMessage ?? ''}`);
  }
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
  };
  return info;
}

export async function createOfflineVideoBufferFromFile(
  path: string
): Promise<OfflineVideoBufferRef> {
  const raw = await getNative().createOfflineVideoBufferFromFile(path, {});
  const info = mapInfo(raw) as OfflineVideoBufferInfo;
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
  path: string,
  live: LiveVideoBufferIdSource,
  options?: IngestFileToLiveOptions
): Promise<LiveVideoBufferInfo> {
  const id = resolveLiveVideoBufferId(live);
  const raw = await getNative().ingestFileToLiveVideoBuffer(id, path, {
    pacing: options?.pacing ?? 'asFast',
  });
  return mapInfo(raw) as LiveVideoBufferInfo;
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
  const raw = await getNative().createOfflineImageBufferFromVideo(id, {
    sampling,
    uniformCount: options?.uniformCount ?? 0,
    fps: options?.fps ?? 0,
    maxSide: options?.maxSide ?? 0,
    timesUs: options?.timesUs,
  });
  if (raw.errorCode) {
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
  CreateEmptyLiveVideoBufferOptions,
  CreateOfflineImageFromVideoOptions,
  ExportVideoFrameOptions,
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
  VideoRetention,
} from './types';
