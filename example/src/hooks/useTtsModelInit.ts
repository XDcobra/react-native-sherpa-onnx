import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  assertTtsCustomConfig,
  createTTS,
  detectTtsModel,
  type TtsCustomConfig,
  type TtsEngine,
  type TTSModelType,
} from 'react-native-sherpa-onnx/tts';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../modelConfig';
import { clearTtsCache, getTtsCache, setTtsCache } from '../engineCache';
import type {
  ModelInitMode,
  TtsCustomInitFormState,
} from '../components/modelInit';
import { fillTtsCustomConfigFromModelFolder } from '../utils/ttsCustomInitFill';

const PAD_PACK_NAME = 'sherpa_models';
const TTS_NUM_THREADS = 2;

export const DEFAULT_TTS_CUSTOM_INIT: TtsCustomInitFormState = {
  modelType: 'vits',
  fileSources: {},
};

export type TtsDetectedModel = { type: TTSModelType; modelDir: string };
export type TtsModelInfo = { sampleRate: number; numSpeakers: number };

export function formatTtsInitError(err: unknown): string {
  if (err instanceof Error) {
    let message = err.message;
    if ('code' in err && typeof err.code === 'string') {
      message = `[${err.code}] ${message}`;
    }
    return message;
  }
  if (typeof err === 'object' && err !== null) {
    const errorObj = err as {
      message?: string;
      code?: string;
      userInfo?: { NSLocalizedDescription?: string };
    };
    const message =
      errorObj.message ??
      errorObj.userInfo?.NSLocalizedDescription ??
      JSON.stringify(err);
    return errorObj.code ? `[${errorObj.code}] ${message}` : message;
  }
  return 'Unknown error';
}

export type UseTtsModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useTtsModelInit(options: UseTtsModelInitOptions = {}) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<TtsCustomInitFormState>(
    DEFAULT_TTS_CUSTOM_INIT
  );
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<TtsDetectedModel[]>([]);
  const [selectedModelType, setSelectedModelType] =
    useState<TTSModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<TtsModelInfo | null>(null);
  const [speakerId, setSpeakerId] = useState('0');
  const [speed, setSpeed] = useState('1.0');

  const engineRef = useRef<TtsEngine | null>(null);

  const catalogEntries = useMemo(
    () =>
      availableModels.map((id) => ({
        id,
        label: getModelDisplayName(id),
      })),
    [availableModels]
  );

  const isEngineInitialized =
    currentModelFolder != null || initializedSummary != null;

  const resolveTtsModelPath = useCallback(
    (modelFolder: string) => {
      if (padModelIds.includes(modelFolder)) {
        return padModelsPath
          ? getFileModelPath(modelFolder, undefined, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds, padModelIds, padModelsPath]
  );

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const assetModels = await listAssetModels();
      const ttsFolders = assetModels
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const downloadedModels = await listDownloadedModels(ModelCategory.Tts);
      const downloadedFolders = downloadedModels.map((model) => model.id);

      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'tts')
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch (e) {
        console.warn('useTtsModelInit: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);

      const combined = [
        ...padFolders,
        ...ttsFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !ttsFolders.includes(f)
        ),
      ];

      setAvailableModels(combined);
      setDownloadedModelIds(downloadedFolders);

      if (combined.length === 0) {
        setError(
          'No TTS models found. Use bundled assets, downloaded models, or PAD models. See TTS_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('useTtsModelInit: Failed to load models:', err);
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadAvailableModels();
  }, [loadAvailableModels]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Tts) return;
      loadAvailableModels().catch(() => {});
    });
    return unsubscribe;
  }, [loadAvailableModels]);

  useEffect(() => {
    const cached = getTtsCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? `custom:${cached.selectedModelType ?? 'unknown'}`
          : getModelDisplayName(cached.modelFolder)
      );
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setModelInfo(cached.modelInfo);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          cached.modelFolder
        )}\nDetected models: ${cached.detectedModels
          .map((m) => m.type)
          .join(', ')}`
      );
    }
  }, []);

  const resetCommonSynthesis = useCallback(() => {
    setSpeakerId('0');
    setSpeed('1.0');
  }, []);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert('Select a model', 'Pick a catalog model folder first.');
        return;
      }
      setLoading(true);
      setError(null);
      setInitResult(null);
      setDetectedModels([]);
      setSelectedModelType(null);
      setInitializedSummary(null);
      setModelInfo(null);
      resetCommonSynthesis();
      await onBeforeInitRef.current?.();

      try {
        const previous = engineRef.current;
        if (previous) {
          await previous.destroy();
          engineRef.current = null;
          clearTtsCache();
        }

        const modelPath = resolveTtsModelPath(modelFolder);

        let engine: TtsEngine;
        try {
          engine = await new Promise((resolve, reject) => {
            setTimeout(() => {
              createTTS({
                modelSource: modelPath,
                numThreads: TTS_NUM_THREADS,
                debug: false,
              })
                .then(resolve)
                .catch(reject);
            }, 50);
          });
        } catch (initErr) {
          console.warn(
            'Initial createTTS failed, retrying with fewer threads',
            initErr
          );
          engine = await createTTS({
            modelSource: modelPath,
            numThreads: 1,
            debug: false,
          });
        }

        const detectResult = await detectTtsModel(
          await toDetectSource(modelPath)
        );
        const normalizedDetected: TtsDetectedModel[] =
          detectResult.success && detectResult.detectedModels?.length
            ? detectResult.detectedModels.map((m) => ({
                ...m,
                type: m.type as TTSModelType,
              }))
            : [{ type: 'vits' as TTSModelType, modelDir: modelFolder }];
        const firstType =
          (detectResult.modelType as TTSModelType) ??
          normalizedDetected[0]?.type ??
          null;

        let modelInfoValue: TtsModelInfo | null = null;
        try {
          const info = await engine.getModelInfo();
          if (
            info &&
            typeof info.sampleRate === 'number' &&
            typeof info.numSpeakers === 'number'
          ) {
            modelInfoValue = {
              sampleRate: info.sampleRate,
              numSpeakers: info.numSpeakers,
            };
          }
        } catch {
          // leave modelInfoValue null
        }

        engineRef.current = engine;
        setDetectedModels(normalizedDetected);
        setCurrentModelFolder(modelFolder);
        setSelectedModelType(firstType);
        setInitializedSummary(getModelDisplayName(modelFolder));
        setModelInfo(modelInfoValue);
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected models: ${normalizedDetected
            .map((m) => m.type)
            .join(', ')}`
        );
        setTtsCache(
          engine,
          modelFolder,
          normalizedDetected,
          firstType,
          modelInfoValue
        );
      } catch (err) {
        console.error('TTS Initialization error:', err);
        const errorMessage = formatTtsInitError(err);
        setError(errorMessage);
        setInitResult(
          `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`
        );
      } finally {
        setLoading(false);
      }
    },
    [resetCommonSynthesis, resolveTtsModelPath]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setInitializedSummary(null);
    setModelInfo(null);
    resetCommonSynthesis();
    await onBeforeInitRef.current?.();

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
        clearTtsCache();
      }

      const customConfig = {
        ...customInitForm.fileSources,
      } as TtsCustomConfig;
      assertTtsCustomConfig(customConfig as unknown as Record<string, unknown>);

      let engine: TtsEngine;
      try {
        engine = await createTTS({
          initMode: 'custom',
          modelType: customInitForm.modelType,
          customConfig,
          numThreads: TTS_NUM_THREADS,
          debug: false,
        });
      } catch (initErr) {
        console.warn(
          'Custom createTTS failed, retrying with 1 thread',
          initErr
        );
        engine = await createTTS({
          initMode: 'custom',
          modelType: customInitForm.modelType,
          customConfig,
          numThreads: 1,
          debug: false,
        });
      }

      let modelInfoValue: TtsModelInfo | null = null;
      try {
        const info = await engine.getModelInfo();
        if (
          info &&
          typeof info.sampleRate === 'number' &&
          typeof info.numSpeakers === 'number'
        ) {
          modelInfoValue = {
            sampleRate: info.sampleRate,
            numSpeakers: info.numSpeakers,
          };
        }
      } catch {
        // leave modelInfoValue null
      }

      const detected: TtsDetectedModel[] = [
        { type: customInitForm.modelType, modelDir: 'custom' },
      ];

      engineRef.current = engine;
      setCurrentModelFolder(null);
      setDetectedModels(detected);
      setSelectedModelType(customInitForm.modelType);
      setInitializedSummary(`custom:${customInitForm.modelType}`);
      setModelInfo(modelInfoValue);
      setInitResult(
        `Initialized (custom): ${
          customInitForm.modelType
        }\nFiles: ${Object.keys(customConfig).join(', ')}`
      );
      setTtsCache(
        engine,
        'custom',
        detected,
        customInitForm.modelType,
        modelInfoValue
      );
    } catch (err) {
      console.error('TTS custom initialization error:', err);
      const errorMessage = formatTtsInitError(err);
      setError(errorMessage);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm, resetCommonSynthesis]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a catalog model folder first.');
      return;
    }

    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const modelPath = resolveTtsModelPath(modelFolder);
      const fillResult = await fillTtsCustomConfigFromModelFolder(modelPath, {
        modelTypeOverride: customInitForm.modelType,
      });
      setCustomInitForm({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
      });
      const missing =
        fillResult.missingKeys.length > 0
          ? ` Missing: ${fillResult.missingKeys.join(', ')}`
          : '';
      setCustomFillHint(
        `Filled from ${getModelDisplayName(modelFolder)} (${
          fillResult.modelDir
        }).${missing}`
      );
    } catch (err) {
      setCustomFillHint(null);
      setError(formatTtsInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveTtsModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick each file from different locations, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      await engine.destroy();
      engineRef.current = null;
    }
    clearTtsCache();
    setCurrentModelFolder(null);
    setInitializedSummary(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setModelInfo(null);
    resetCommonSynthesis();
    setError(null);
  }, [resetCommonSynthesis]);

  const applySelectedModel = useCallback(() => {
    if (initMode === 'custom') {
      return initializeCustom();
    }
    return initializeAuto(selectedModelForInit ?? '');
  }, [initMode, initializeAuto, initializeCustom, selectedModelForInit]);

  return {
    engineRef,
    availableModels,
    catalogEntries,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    customFillLoading,
    customFillHint,
    selectedModelForInit,
    setSelectedModelForInit,
    initializedSummary,
    loadingModels,
    initResult,
    currentModelFolder,
    detectedModels,
    selectedModelType,
    setSelectedModelType,
    loading,
    error,
    setError,
    modelInfo,
    speakerId,
    setSpeakerId,
    speed,
    setSpeed,
    isEngineInitialized,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
  };
}
