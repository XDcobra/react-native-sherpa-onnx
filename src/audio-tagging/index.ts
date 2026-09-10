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
export { AUDIO_TAGGING_MODEL_TYPES, AudioTaggingErrorCode } from './types';
export type {
  AudioTaggingAutoInitializeOptions,
  AudioTaggingConcreteModelType,
  AudioTaggingCustomInitializeOptions,
  AudioTaggingEngine,
  AudioTaggingEvent,
  AudioTaggingInitOptionsShared,
  AudioTaggingInitializeOptions,
  AudioTaggingModelType,
  AudioTaggingResult,
  AudioTaggingTagOptions,
} from './types';
