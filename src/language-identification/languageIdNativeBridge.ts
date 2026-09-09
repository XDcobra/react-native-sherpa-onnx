import type { LanguageIdInitBridgeOptions } from '../NativeSherpaOnnx';
import type { LanguageIdentificationInitializeOptions } from './types';
import { LanguageIdErrorCode } from './types';
import { detectLanguageIdModel } from './detectLanguageIdModel';
import { resolveLanguageIdCustomConfigPaths } from './customConfig';

export type { LanguageIdInitBridgeOptions };

export async function buildLanguageIdInitBridgeOptions(
  options: LanguageIdentificationInitializeOptions
): Promise<LanguageIdInitBridgeOptions> {
  const hasModelSource = options.modelSource != null;
  const hasCustomConfig = options.customConfig != null;

  if (!hasModelSource && !hasCustomConfig) {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: Either modelSource or customConfig must be provided`
    );
  }

  if (hasModelSource && hasCustomConfig) {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: Cannot provide both modelSource and customConfig`
    );
  }

  let encoderPath: string;
  let decoderPath: string;

  if (hasCustomConfig && options.customConfig) {
    const paths = await resolveLanguageIdCustomConfigPaths(
      'whisper',
      options.customConfig
    );
    if (!paths.encoder || !paths.decoder) {
      throw new Error(
        `${LanguageIdErrorCode.INVALID_ARGUMENT}: customConfig must contain valid encoder and decoder paths`
      );
    }
    encoderPath = paths.encoder;
    decoderPath = paths.decoder;
  } else if (options.modelSource) {
    const detect = await detectLanguageIdModel(options.modelSource, {
      quantization: options.quantization,
    });

    if (!detect.success) {
      throw new Error(
        `${LanguageIdErrorCode.INIT_FAILED}: ${
          detect.error ?? 'Failed to detect Language ID model'
        }`
      );
    }

    if (!detect.paths?.encoder || !detect.paths?.decoder) {
      throw new Error(
        `${LanguageIdErrorCode.INIT_FAILED}: Detected model is missing encoder or decoder path`
      );
    }

    encoderPath = detect.paths.encoder;
    decoderPath = detect.paths.decoder;
  } else {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: Invalid model configuration`
    );
  }

  return {
    encoder: encoderPath,
    decoder: decoderPath,
    ...(options.tailPaddings !== undefined
      ? { tailPaddings: options.tailPaddings }
      : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}
