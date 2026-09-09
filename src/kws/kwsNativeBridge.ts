import type { KeywordSpottingInitBridgeOptions } from '../NativeSherpaOnnx';
import type { KeywordSpottingInitOptions } from './types';

export type KeywordSpottingDetectedPaths = {
  encoder?: string;
  decoder?: string;
  joiner?: string;
  tokens?: string;
  keywords?: string;
};

export function buildKeywordSpottingInitBridgeOptions(
  detectedPaths: KeywordSpottingDetectedPaths,
  options: Pick<
    KeywordSpottingInitOptions,
    | 'keywordsScore'
    | 'keywordsThreshold'
    | 'numTrailingBlanks'
    | 'maxActivePaths'
    | 'numThreads'
    | 'provider'
    | 'debug'
  >
): KeywordSpottingInitBridgeOptions {
  // Pack keywords.txt for KeywordSpotter construction. Optional keywordsPath
  // is applied on spot via createStream (safe OOV reject) — see KNOWN_ISSUES.
  const required = {
    encoder: detectedPaths.encoder?.trim(),
    decoder: detectedPaths.decoder?.trim(),
    joiner: detectedPaths.joiner?.trim(),
    tokens: detectedPaths.tokens?.trim(),
    keywords: detectedPaths.keywords?.trim(),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Keyword spotting detected model is missing required paths: ${missing.join(
        ', '
      )}`
    );
  }

  return {
    encoder: required.encoder!,
    decoder: required.decoder!,
    joiner: required.joiner!,
    tokens: required.tokens!,
    keywords: required.keywords!,
    keywordsScore: options.keywordsScore ?? 1.5,
    keywordsThreshold: options.keywordsThreshold ?? 0.25,
    numTrailingBlanks: options.numTrailingBlanks ?? 2,
    maxActivePaths: options.maxActivePaths ?? 4,
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}
