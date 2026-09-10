export { detectAudioTaggingModel } from './detectAudioTaggingModel';
export type { AudioTaggingDetectOptions } from './detectAudioTaggingModel';
export type { AudioTaggingDetectModelResult } from '../types/modelDetect';

export { createAudioTagging } from './createAudioTagging';
export {
  assertAudioTaggingCustomConfig,
  resolveAudioTaggingCustomConfigPaths,
} from './customConfig';
export type {
  AudioTaggingCustomConfig,
  AudioTaggingCustomPathKey,
} from './customConfig';
export { buildAudioTaggingInitBridgeOptions } from './audioTaggingNativeBridge';
export type { AudioTaggingInitBridgeOptions } from './audioTaggingNativeBridge';
export {
  isLiveAudioSource,
  isLiveSegmentSource,
  isLiveTextSource,
  assertAudioTaggingLiveSpanPolicy,
  tagLiveOverload,
} from './live';
export {
  collectSpeechSpans,
  normalizeAudioTaggingNativeResult,
  runOfflineAudioTaggingSegmentation,
  spanDurationMs,
} from './orchestrate';
export type {
  AudioTaggingPipelineHandle,
  StreamingPipelineCompletion,
  StreamingPipelineStatus,
} from './streamingTypes';
export {
  AUDIO_TAGGING_MODEL_TYPES,
  AUDIO_TAGGING_LIVE_MIN_SPAN_MS,
  AudioTaggingErrorCode,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
} from './types';
export type {
  AudioTaggingAutoInitializeOptions,
  AudioTaggingConcreteModelType,
  AudioTaggingCustomInitializeOptions,
  AudioTaggingEngine,
  AudioTaggingEvent,
  AudioTaggingInitOptionsShared,
  AudioTaggingInitializeOptions,
  AudioTaggingLivePipelineOptions,
  AudioTaggingLiveSegmentEvent,
  AudioTaggingModelType,
  AudioTaggingResult,
  AudioTaggingSegmentEvent,
  AudioTaggingTagOptions,
  SegmentedAudioTaggingResult,
} from './types';
