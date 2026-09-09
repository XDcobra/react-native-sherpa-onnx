import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { detectKwsModel } from './detectKwsModel';
import { buildKeywordSpottingInitBridgeOptions } from './kwsNativeBridge';
import type {
  KeywordSpottingEngine,
  KeywordSpottingInitOptions,
} from './types';

let keywordSpottingInstanceCounter = 0;

export async function createKeywordSpotting(
  options: KeywordSpottingInitOptions
): Promise<KeywordSpottingEngine> {
  if (options == null || typeof options !== 'object' || !options.modelSource) {
    throw new Error(
      'Keyword spotting initialization requires a modelSource option'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  const detected = await detectKwsModel(
    { kind: 'fs', path: modelDir },
    { quantization: options.quantization }
  );
  if (!detected.success) {
    throw new Error(
      `Keyword spotting model detection failed for ${modelDir}: ${
        detected.error ?? 'Unknown error'
      }`
    );
  }
  if (!detected.isStreaming) {
    throw new Error(
      `Keyword spotting requires a streaming (online) KWS pack for ${modelDir}`
    );
  }
  if (!detected.paths) {
    throw new Error(
      `Keyword spotting model detection returned no paths for ${modelDir}`
    );
  }

  const bridgeOptions = buildKeywordSpottingInitBridgeOptions(
    detected.paths,
    options
  );
  const instanceId = `keyword_spotting_${++keywordSpottingInstanceCounter}`;
  const result = await SherpaOnnx.initializeKeywordSpotting(
    instanceId,
    bridgeOptions
  );
  if (!result.success) {
    const error = result.error?.trim();
    throw new Error(
      error
        ? `Keyword spotting initialization failed: ${error}`
        : `Keyword spotting initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  return {
    get instanceId() {
      return instanceId;
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadKeywordSpotting(instanceId);
    },
  };
}

export const createStreamingKWS = createKeywordSpotting;
