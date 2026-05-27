import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsSynthesisOptions,
  TtsKittenModelOptions,
  TtsKokoroModelOptions,
  TtsMatchaModelOptions,
  TtsModelOptions,
  TtsUpdateOptions,
  TtsVitsModelOptions,
} from './types';
import type { TtsInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';

export type FlattenedTtsModelNativeOptions = {
  noiseScale: number | undefined;
  noiseScaleW: number | undefined;
  lengthScale: number | undefined;
};

/**
 * Flatten model-specific options for the given model type to native init/update params.
 * When modelType is 'auto' or missing, returns undefined for all (native uses defaults).
 */
export function flattenTtsModelOptionsForNative(
  modelType: TTSModelType | undefined,
  modelOptions: TtsModelOptions | undefined
): FlattenedTtsModelNativeOptions {
  if (
    !modelOptions ||
    !modelType ||
    modelType === 'auto' ||
    modelType === 'zipvoice'
  ) {
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  }
  const block =
    modelType === 'vits'
      ? modelOptions.vits
      : modelType === 'matcha'
      ? modelOptions.matcha
      : modelType === 'kokoro'
      ? modelOptions.kokoro
      : modelType === 'kitten'
      ? modelOptions.kitten
      : modelType === 'pocket'
      ? modelOptions.pocket
      : modelType === 'supertonic'
      ? modelOptions.supertonic
      : undefined;
  if (!block) {
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  }
  const n = block as {
    noiseScale?: number;
    noiseScaleW?: number;
    lengthScale?: number;
  };
  return {
    noiseScale:
      n.noiseScale !== undefined && typeof n.noiseScale === 'number'
        ? n.noiseScale
        : undefined,
    noiseScaleW:
      n.noiseScaleW !== undefined && typeof n.noiseScaleW === 'number'
        ? n.noiseScaleW
        : undefined,
    lengthScale:
      n.lengthScale !== undefined && typeof n.lengthScale === 'number'
        ? n.lengthScale
        : undefined,
  };
}

function modelOptionsBagFromInit(
  options: TTSInitializeOptions
): TtsModelOptions | undefined {
  const mt = options.modelType;
  if (mt === undefined || mt === 'auto') {
    return undefined;
  }
  if (mt === 'zipvoice' || mt === 'pocket' || mt === 'supertonic') {
    return undefined;
  }
  if (!('modelOptions' in options) || options.modelOptions == null) {
    return undefined;
  }
  switch (mt) {
    case 'vits':
      return { vits: options.modelOptions.vits };
    case 'matcha':
      return { matcha: options.modelOptions.matcha };
    case 'kokoro':
      return { kokoro: options.modelOptions.kokoro };
    case 'kitten':
      return { kitten: options.modelOptions.kitten };
    default:
      return undefined;
  }
}

export type ExpandedTtsInitFields = {
  modelSource: TTSInitializeOptions['modelSource'];
  modelType: TTSModelType | undefined;
  provider: string | undefined;
  numThreads: number | undefined;
  debug: boolean | undefined;
  modelOptions: TtsModelOptions | undefined;
  ruleFsts: string | undefined;
  ruleFars: string | undefined;
  maxNumSentences: number | undefined;
  silenceScale: number | undefined;
  lexiconLanguageId: string | undefined;
};

export type { TtsInitBridgeOptions };

export function buildTtsInitBridgeOptions(
  modelDir: string,
  expanded: ExpandedTtsInitFields,
  flat: FlattenedTtsModelNativeOptions
): TtsInitBridgeOptions {
  const kokoroLang =
    expanded.modelOptions?.kokoro?.lang !== undefined &&
    typeof expanded.modelOptions.kokoro.lang === 'string' &&
    expanded.modelOptions.kokoro.lang.length > 0
      ? expanded.modelOptions.kokoro.lang
      : undefined;
  return {
    modelDir,
    modelType: expanded.modelType ?? 'auto',
    ...(expanded.numThreads !== undefined
      ? { numThreads: expanded.numThreads }
      : {}),
    ...(expanded.debug !== undefined ? { debug: expanded.debug } : {}),
    ...(flat.noiseScale !== undefined ? { noiseScale: flat.noiseScale } : {}),
    ...(flat.noiseScaleW !== undefined
      ? { noiseScaleW: flat.noiseScaleW }
      : {}),
    ...(flat.lengthScale !== undefined
      ? { lengthScale: flat.lengthScale }
      : {}),
    ...(expanded.ruleFsts !== undefined ? { ruleFsts: expanded.ruleFsts } : {}),
    ...(expanded.ruleFars !== undefined ? { ruleFars: expanded.ruleFars } : {}),
    ...(expanded.maxNumSentences !== undefined
      ? { maxNumSentences: expanded.maxNumSentences }
      : {}),
    ...(expanded.silenceScale !== undefined
      ? { silenceScale: expanded.silenceScale }
      : {}),
    ...(expanded.provider !== undefined ? { provider: expanded.provider } : {}),
    ...(expanded.lexiconLanguageId !== undefined
      ? { lexiconLanguageId: expanded.lexiconLanguageId }
      : {}),
    ...(kokoroLang !== undefined ? { kokoroLang } : {}),
  };
}

export function expandTtsInitializeOptions(
  options: TTSInitializeOptions
): ExpandedTtsInitFields {
  return {
    modelSource: options.modelSource,
    modelType: options.modelType,
    provider:
      options.provider !== undefined ? String(options.provider) : undefined,
    numThreads: options.numThreads,
    debug: options.debug,
    modelOptions: modelOptionsBagFromInit(options),
    ruleFsts: options.ruleFsts,
    ruleFars: options.ruleFars,
    maxNumSentences: options.maxNumSentences,
    silenceScale: options.silenceScale,
    lexiconLanguageId: options.lexiconLanguageId,
  };
}

export function expandTtsUpdateOptions(opts: TtsUpdateOptions): {
  modelType: TTSModelType | undefined;
  modelOptions: TtsModelOptions | undefined;
} {
  if (!('modelType' in opts) || opts.modelType === undefined) {
    return { modelType: undefined, modelOptions: undefined };
  }
  if (opts.modelType === 'auto') {
    return { modelType: 'auto', modelOptions: undefined };
  }
  const mt = opts.modelType;
  if (mt === 'zipvoice' || mt === 'pocket' || mt === 'supertonic') {
    return { modelType: mt, modelOptions: undefined };
  }
  const mo = opts.modelOptions;
  if (mo == null) {
    return { modelType: mt, modelOptions: undefined };
  }
  switch (mt) {
    case 'vits': {
      const b = mo as { vits: TtsVitsModelOptions };
      return { modelType: mt, modelOptions: { vits: b.vits } };
    }
    case 'matcha': {
      const b = mo as { matcha: TtsMatchaModelOptions };
      return { modelType: mt, modelOptions: { matcha: b.matcha } };
    }
    case 'kokoro': {
      const b = mo as { kokoro: TtsKokoroModelOptions };
      return { modelType: mt, modelOptions: { kokoro: b.kokoro } };
    }
    case 'kitten': {
      const b = mo as { kitten: TtsKittenModelOptions };
      return { modelType: mt, modelOptions: { kitten: b.kitten } };
    }
    default:
      return { modelType: mt, modelOptions: undefined };
  }
}

/**
 * Convert TtsSynthesisOptions to a flat object for the native bridge.
 * VoiceClone reference audio is passed as a buffer ID (not raw samples).
 */
export function toNativeSynthesisOptions(
  options?: TtsSynthesisOptions
): Record<string, unknown> | undefined {
  if (options == null) return undefined;
  const out: Record<string, unknown> = {};
  if (options.sid !== undefined) out.sid = options.sid;
  if (options.speed !== undefined) out.speed = options.speed;
  if (options.silenceScale !== undefined) {
    out.silenceScale = options.silenceScale;
  }
  if (options.numSteps !== undefined) out.numSteps = options.numSteps;
  if (options.lang !== undefined && options.lang.length > 0) {
    out.lang = options.lang;
  }
  if (options.extra != null && Object.keys(options.extra).length > 0) {
    out.extra = options.extra;
  }
  if (options.voiceClone != null) {
    const vc = options.voiceClone;
    const refBufferId = resolvePipelineAudioBufferId(
      vc.referenceAudio as OfflineAudioBufferIdSource
    );
    out.referenceAudioBufferId = refBufferId;
    if (vc.kind === 'zipvoice') {
      const referenceText = vc.referenceText?.trim() ?? '';
      if (referenceText.length === 0) {
        throw new Error(
          '[TTS] Zipvoice voice cloning requires a non-empty referenceText in voiceClone options.'
        );
      }
      out.referenceText = referenceText;
    } else if (vc.referenceText !== undefined) {
      out.referenceText = vc.referenceText.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
