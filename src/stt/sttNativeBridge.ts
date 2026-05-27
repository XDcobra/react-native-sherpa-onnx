import type { STTInitializeOptions } from './types';
import type {
  OnlineSttInitBridgeOptions,
  SttInitBridgeOptions,
} from '../nativeBridge/initBridgeTypes';
import type { StreamingSttInitOptions } from './streamingTypes';

export type { OnlineSttInitBridgeOptions, SttInitBridgeOptions };

export function buildSttInitBridgeOptions(
  modelDir: string,
  options: STTInitializeOptions
): SttInitBridgeOptions {
  return {
    modelDir,
    ...(options.preferInt8 !== undefined
      ? { preferInt8: options.preferInt8 }
      : {}),
    ...(options.modelType !== undefined
      ? { modelType: options.modelType }
      : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.hotwordsFile !== undefined
      ? { hotwordsFile: options.hotwordsFile }
      : {}),
    ...(options.hotwordsScore !== undefined
      ? { hotwordsScore: options.hotwordsScore }
      : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.ruleFsts !== undefined ? { ruleFsts: options.ruleFsts } : {}),
    ...(options.ruleFars !== undefined ? { ruleFars: options.ruleFars } : {}),
    ...(options.dither !== undefined ? { dither: options.dither } : {}),
    ...(options.modelOptions !== undefined
      ? { modelOptions: options.modelOptions }
      : {}),
    ...(options.modelingUnit !== undefined
      ? { modelingUnit: options.modelingUnit }
      : {}),
    ...(options.bpeVocab !== undefined ? { bpeVocab: options.bpeVocab } : {}),
  };
}

/**
 * Flatten public streaming init options for `initializeOnlineStt` (endpoint rules → top-level keys).
 */
export function buildOnlineSttInitBridgeOptions(
  modelDir: string,
  options: StreamingSttInitOptions & { modelType: string }
): OnlineSttInitBridgeOptions {
  const ep = options.endpointConfig;
  return {
    modelDir,
    modelType: options.modelType,
    enableEndpoint: options.enableEndpoint ?? true,
    decodingMethod: options.decodingMethod ?? 'greedy_search',
    maxActivePaths: options.maxActivePaths ?? 4,
    ...(options.hotwordsFile !== undefined
      ? { hotwordsFile: options.hotwordsFile }
      : {}),
    ...(options.hotwordsScore !== undefined
      ? { hotwordsScore: options.hotwordsScore }
      : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.ruleFsts !== undefined ? { ruleFsts: options.ruleFsts } : {}),
    ...(options.ruleFars !== undefined ? { ruleFars: options.ruleFars } : {}),
    ...(options.dither !== undefined ? { dither: options.dither } : {}),
    ...(options.blankPenalty !== undefined
      ? { blankPenalty: options.blankPenalty }
      : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(ep?.rule1?.mustContainNonSilence !== undefined
      ? { rule1MustContainNonSilence: ep.rule1.mustContainNonSilence }
      : {}),
    ...(ep?.rule1?.minTrailingSilence !== undefined
      ? { rule1MinTrailingSilence: ep.rule1.minTrailingSilence }
      : {}),
    ...(ep?.rule1?.minUtteranceLength !== undefined
      ? { rule1MinUtteranceLength: ep.rule1.minUtteranceLength }
      : {}),
    ...(ep?.rule2?.mustContainNonSilence !== undefined
      ? { rule2MustContainNonSilence: ep.rule2.mustContainNonSilence }
      : {}),
    ...(ep?.rule2?.minTrailingSilence !== undefined
      ? { rule2MinTrailingSilence: ep.rule2.minTrailingSilence }
      : {}),
    ...(ep?.rule2?.minUtteranceLength !== undefined
      ? { rule2MinUtteranceLength: ep.rule2.minUtteranceLength }
      : {}),
    ...(ep?.rule3?.mustContainNonSilence !== undefined
      ? { rule3MustContainNonSilence: ep.rule3.mustContainNonSilence }
      : {}),
    ...(ep?.rule3?.minTrailingSilence !== undefined
      ? { rule3MinTrailingSilence: ep.rule3.minTrailingSilence }
      : {}),
    ...(ep?.rule3?.minUtteranceLength !== undefined
      ? { rule3MinUtteranceLength: ep.rule3.minUtteranceLength }
      : {}),
  };
}
