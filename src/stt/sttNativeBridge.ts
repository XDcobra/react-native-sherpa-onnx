import type {
  STTAutoInitializeOptions,
  STTCustomInitializeOptions,
  STTInitializeOptions,
  STTInitializeOptionsBase,
} from './types';
import type {
  OnlineSttInitBridgeOptions,
  SttInitBridgeOptions,
} from '../nativeBridge/initBridgeTypes';
import type { StreamingSttInitOptions } from './streamingTypes';
import { resolveFileSourceForModelFile } from '../detect/resolveModelInput';
import { resolveSttCustomConfigPaths } from './customConfig';

export type { OnlineSttInitBridgeOptions, SttInitBridgeOptions };

async function resolveOptionalFileSourcePath(
  source: import('../fileio/types').FileSource | undefined
): Promise<string | undefined> {
  if (source === undefined) {
    return undefined;
  }
  return resolveFileSourceForModelFile(source);
}

async function resolveOptionalFileSourceList(
  sources:
    | import('../fileio/types').FileSource
    | readonly import('../fileio/types').FileSource[]
    | undefined
): Promise<string | undefined> {
  if (sources === undefined) {
    return undefined;
  }
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.length === 0) {
    return undefined;
  }
  const paths = await Promise.all(
    list.map((source) => resolveFileSourceForModelFile(source))
  );
  return paths.join(',');
}

function appendSharedInitBridgeFields(
  options: STTInitializeOptionsBase,
  resolved: {
    hotwordsFile?: string;
    bpeVocab?: string;
    ruleFsts?: string;
    ruleFars?: string;
  }
): Omit<
  SttInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType' | 'preferInt8'
> {
  return {
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(resolved.hotwordsFile !== undefined
      ? { hotwordsFile: resolved.hotwordsFile }
      : {}),
    ...(options.hotwordsScore !== undefined
      ? { hotwordsScore: options.hotwordsScore }
      : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(resolved.ruleFsts !== undefined ? { ruleFsts: resolved.ruleFsts } : {}),
    ...(resolved.ruleFars !== undefined ? { ruleFars: resolved.ruleFars } : {}),
    ...(options.dither !== undefined ? { dither: options.dither } : {}),
    ...(options.modelOptions !== undefined
      ? { modelOptions: options.modelOptions }
      : {}),
    ...(options.modelingUnit !== undefined
      ? { modelingUnit: options.modelingUnit }
      : {}),
    ...(resolved.bpeVocab !== undefined ? { bpeVocab: resolved.bpeVocab } : {}),
  };
}

async function resolveSharedFilePaths(
  options: STTInitializeOptionsBase
): Promise<{
  hotwordsFile?: string;
  bpeVocab?: string;
  ruleFsts?: string;
  ruleFars?: string;
}> {
  const [hotwordsFile, bpeVocab, ruleFsts, ruleFars] = await Promise.all([
    resolveOptionalFileSourcePath(options.hotwordsFile),
    resolveOptionalFileSourcePath(options.bpeVocab),
    resolveOptionalFileSourceList(options.ruleFsts),
    resolveOptionalFileSourceList(options.ruleFars),
  ]);
  return {
    ...(hotwordsFile !== undefined ? { hotwordsFile } : {}),
    ...(bpeVocab !== undefined ? { bpeVocab } : {}),
    ...(ruleFsts !== undefined ? { ruleFsts } : {}),
    ...(ruleFars !== undefined ? { ruleFars } : {}),
  };
}

export async function buildSttInitBridgeOptions(
  options: STTInitializeOptions
): Promise<SttInitBridgeOptions> {
  const sharedPaths = await resolveSharedFilePaths(options);
  const sharedFields = appendSharedInitBridgeFields(options, sharedPaths);

  if (options.initMode === 'custom') {
    const customOptions = options as STTCustomInitializeOptions;
    const modelPaths = await resolveSttCustomConfigPaths(
      customOptions.modelType,
      customOptions.customConfig
    );
    return {
      initMode: 'custom',
      modelType: customOptions.modelType,
      modelPaths,
      ...sharedFields,
    };
  }

  const autoOptions = options as STTAutoInitializeOptions;
  const { resolveFileSourceForModelInit } = await import(
    '../detect/resolveModelInput'
  );
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    ...(autoOptions.preferInt8 !== undefined
      ? { preferInt8: autoOptions.preferInt8 }
      : {}),
    ...(autoOptions.modelType !== undefined
      ? { modelType: autoOptions.modelType }
      : {}),
    ...sharedFields,
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
