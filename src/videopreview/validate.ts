import { VideoPreviewError, VideoPreviewErrorCode } from './types';
import type { VideoPreviewPlayerOptions } from './types';

export function asVideoPreviewPlayerId(
  id: string
): string & { readonly __brand: 'VideoPreviewPlayerId' } {
  return id as string & { readonly __brand: 'VideoPreviewPlayerId' };
}

export function validateCreateOptions(
  options?: VideoPreviewPlayerOptions
): void {
  if (options == null) {
    return;
  }
  if (options.startAtMs != null && !Number.isFinite(options.startAtMs)) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'startAtMs must be finite'
    );
  }
  if (options.volume != null && (options.volume < 0 || options.volume > 1)) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'volume must be in [0, 1]'
    );
  }
  if (options.progressIntervalMs != null) {
    if (
      !Number.isFinite(options.progressIntervalMs) ||
      options.progressIntervalMs < 50 ||
      options.progressIntervalMs > 5000
    ) {
      throw new VideoPreviewError(
        VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
        'progressIntervalMs must be in [50, 5000]'
      );
    }
  }
  if (
    options.live?.targetLatencyMs != null &&
    options.live.targetLatencyMs < 0
  ) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'live.targetLatencyMs must be >= 0'
    );
  }
  if (options.live?.maxLatencyMs != null && options.live.maxLatencyMs < 0) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'live.maxLatencyMs must be >= 0'
    );
  }
  const target = options.live?.targetLatencyMs ?? 1000;
  const maxL = options.live?.maxLatencyMs;
  if (maxL != null && maxL <= target) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'live.maxLatencyMs must be > targetLatencyMs'
    );
  }
}

export function validateSeekMs(positionMs: number): void {
  if (!Number.isFinite(positionMs)) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'positionMs must be finite'
    );
  }
}

export function validateVolume(volume: number): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new VideoPreviewError(
      VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_ARGUMENT,
      'volume must be in [0, 1]'
    );
  }
}

export function nativeErrorToPreview(e: unknown): VideoPreviewError {
  if (e instanceof VideoPreviewError) {
    return e;
  }
  const err = e as { code?: string; message?: string };
  const code = (err.code ??
    VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_STATE) as (typeof VideoPreviewErrorCode)[keyof typeof VideoPreviewErrorCode];
  const known = Object.values(VideoPreviewErrorCode) as string[];
  if (known.includes(code)) {
    return new VideoPreviewError(
      code as (typeof VideoPreviewErrorCode)[keyof typeof VideoPreviewErrorCode],
      err.message ?? code,
      e
    );
  }
  return new VideoPreviewError(
    VideoPreviewErrorCode.VIDEO_PREVIEW_INVALID_STATE,
    err.message ?? 'video preview failed',
    e
  );
}
