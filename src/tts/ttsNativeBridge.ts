import type {
  TTSInitializeOptions,
  TTSModelType,
  TTSCustomInitializeOptions,
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
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveTtsCustomConfigPaths } from './customConfig';

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
    case 'vits': {
      const mo = options.modelOptions as { vits: TtsVitsModelOptions };
      return { vits: mo.vits };
    }
    case 'matcha': {
      const mo = options.modelOptions as { matcha: TtsMatchaModelOptions };
      return { matcha: mo.matcha };
    }
    case 'kokoro': {
      const mo = options.modelOptions as { kokoro: TtsKokoroModelOptions };
      return { kokoro: mo.kokoro };
    }
    case 'kitten': {
      const mo = options.modelOptions as { kitten: TtsKittenModelOptions };
      return { kitten: mo.kitten };
    }
    default:
      return undefined;
  }
}

function kokoroLangFromInit(options: TTSInitializeOptions): string | undefined {
  const bag = modelOptionsBagFromInit(options);
  const lang = bag?.kokoro?.lang;
  return lang !== undefined && typeof lang === 'string' && lang.length > 0
    ? lang
    : undefined;
}

function appendTtsScalarBridgeFields(
  options: TTSInitializeOptions,
  flat: FlattenedTtsModelNativeOptions
): Omit<
  TtsInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  const kokoroLang = kokoroLangFromInit(options);
  return {
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(flat.noiseScale !== undefined ? { noiseScale: flat.noiseScale } : {}),
    ...(flat.noiseScaleW !== undefined
      ? { noiseScaleW: flat.noiseScaleW }
      : {}),
    ...(flat.lengthScale !== undefined
      ? { lengthScale: flat.lengthScale }
      : {}),
    ...(options.ruleFsts !== undefined ? { ruleFsts: options.ruleFsts } : {}),
    ...(options.ruleFars !== undefined ? { ruleFars: options.ruleFars } : {}),
    ...(options.maxNumSentences !== undefined
      ? { maxNumSentences: options.maxNumSentences }
      : {}),
    ...(options.silenceScale !== undefined
      ? { silenceScale: options.silenceScale }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(kokoroLang !== undefined ? { kokoroLang } : {}),
  };
}

export type { TtsInitBridgeOptions };

export async function buildTtsInitBridgeOptions(
  options: TTSInitializeOptions
): Promise<TtsInitBridgeOptions> {
  const flat = flattenTtsModelOptionsForNative(
    options.modelType,
    modelOptionsBagFromInit(options)
  );
  const scalarFields = appendTtsScalarBridgeFields(options, flat);

  if (options.initMode === 'custom') {
    const customOptions = options as TTSCustomInitializeOptions;
    const modelPaths = await resolveTtsCustomConfigPaths(
      customOptions.modelType,
      customOptions.customConfig
    );
    return {
      initMode: 'custom',
      modelType: customOptions.modelType,
      modelPaths,
      ...scalarFields,
    };
  }

  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: options.modelType ?? 'auto',
    ...(options.lexiconLanguageId !== undefined
      ? { lexiconLanguageId: options.lexiconLanguageId }
      : {}),
    ...scalarFields,
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
