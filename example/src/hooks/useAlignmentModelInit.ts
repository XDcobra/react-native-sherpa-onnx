import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  createAlignment,
  detectAlignmentModel,
  type AlignmentEngine,
  type AlignmentModelType,
} from 'react-native-sherpa-onnx/alignment';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearAlignmentCache,
  getAlignmentCache,
  setAlignmentCache,
  type AlignmentCachedPrepInfo,
} from '../engineCache';
import type {
  AlignmentCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import { fillAlignmentCustomConfigFromModelFolder } from '../utils/alignmentCustomInitFill';
import { useAlignmentModelCatalog } from './useAlignmentModelCatalog';

export const DEFAULT_ALIGNMENT_CUSTOM_INIT: AlignmentCustomInitFormState = {
  fileSources: {},
};

export function formatAlignmentInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  return typeof err === 'string' ? err : String(err);
}

export type UseAlignmentModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useAlignmentModelInit(
  options: UseAlignmentModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useAlignmentModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<AlignmentCustomInitFormState>(DEFAULT_ALIGNMENT_CUSTOM_INIT);
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [preparedModelPath, setPreparedModelPath] = useState<string | null>(
    null
  );
  const [preparedModelType, setPreparedModelType] = useState<
    AlignmentModelType | string | null
  >(null);
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [initResult, setInitResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<AlignmentEngine | null>(null);
  const [isPrepared, setIsPrepared] = useState(false);

  useEffect(() => {
    if (!catalogError) return;
    setError(catalogError);
  }, [catalogError]);

  useEffect(() => {
    if (
      selectedModelForInit &&
      catalogEntries.some((e) => e.id === selectedModelForInit)
    ) {
      return;
    }
    setSelectedModelForInit(catalogEntries[0]?.id ?? null);
  }, [catalogEntries, selectedModelForInit]);

  useEffect(() => {
    const cached = getAlignmentCache();
    if (cached.engine == null || cached.prepInfo == null) {
      return;
    }
    engineRef.current = cached.engine;
    const prep = cached.prepInfo;
    setInitMode(prep.initMode);
    setPreparedModelPath(prep.modelPath);
    setPreparedModelType(prep.modelType);
    if (prep.initMode === 'auto' && prep.modelFolder) {
      setCurrentModelFolder(prep.modelFolder);
      setSelectedModelForInit(null);
      setInitializedSummary(getModelDisplayName(prep.modelFolder));
    } else if (prep.initMode === 'custom') {
      setCurrentModelFolder(null);
      setCustomInitForm({
        fileSources: prep.customConfig ?? {},
      });
      setInitializedSummary('custom:wav2vec2');
    }
    setInitResult(cached.initMessage);
    setIsPrepared(true);
  }, []);

  const ensureAlignmentEngine =
    useCallback(async (): Promise<AlignmentEngine> => {
      if (engineRef.current) {
        return engineRef.current;
      }
      const cached = getAlignmentCache();
      if (cached.engine) {
        engineRef.current = cached.engine;
        return cached.engine;
      }
      const engine = createAlignment();
      engineRef.current = engine;
      setAlignmentCache(
        engine,
        {
          initMode: 'auto',
          modelFolder: null,
          modelPath: null,
          modelType: null,
          customConfig: null,
        },
        null
      );
      return engine;
    }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    engineRef.current = null;
    clearAlignmentCache();
    setCurrentModelFolder(null);
    setPreparedModelPath(null);
    setPreparedModelType(null);
    setInitializedSummary(null);
    setInitResult(null);
    setIsPrepared(false);
  }, []);

  const persistCache = useCallback(
    (
      engine: AlignmentEngine,
      prepInfo: AlignmentCachedPrepInfo,
      message: string
    ) => {
      setAlignmentCache(engine, prepInfo, message);
    },
    []
  );

  const applySelectedModelAuto = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick an alignment catalog folder first.');
      return;
    }

    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const modelSource = resolveModelPath(modelFolder);
      const detection = await detectAlignmentModel(
        await toDetectSource(modelSource),
        { modelType: 'auto' as AlignmentModelType }
      );
      const modelPath = detection.paths?.model?.trim();
      if (!detection.success || !modelPath) {
        throw new Error(
          detection.error ||
            'Alignment model detection failed: no model path found.'
        );
      }

      const engine = await ensureAlignmentEngine();
      const modelType =
        detection.modelType ?? detection.detectedModels[0]?.type ?? null;
      const prepInfo: AlignmentCachedPrepInfo = {
        initMode: 'auto',
        modelFolder,
        modelPath,
        modelType,
        customConfig: null,
      };
      const summary = getModelDisplayName(modelFolder);
      const message = `Ready: ${summary}\nmodel: ${modelPath}`;
      setCurrentModelFolder(modelFolder);
      setSelectedModelForInit(modelFolder);
      setPreparedModelPath(modelPath);
      setPreparedModelType(modelType);
      setInitializedSummary(summary);
      setInitResult(message);
      persistCache(engine, prepInfo, message);
      setIsPrepared(true);
    } catch (err) {
      const errorMessage = formatAlignmentInitError(err);
      setError(errorMessage);
      setInitResult(`Initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [
    ensureAlignmentEngine,
    persistCache,
    releaseCurrentEngine,
    resolveModelPath,
    selectedModelForInit,
  ]);

  const applySelectedModelCustom = useCallback(async () => {
    if (!customInitForm.fileSources.model) {
      Alert.alert(
        'Custom model',
        'Set the custom alignment model path (model slot) first.'
      );
      return;
    }

    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const engine = await ensureAlignmentEngine();
      const prepInfo: AlignmentCachedPrepInfo = {
        initMode: 'custom',
        modelFolder: null,
        modelPath: null,
        modelType: 'wav2vec2',
        customConfig: { ...customInitForm.fileSources },
      };
      const message = 'Ready: custom wav2vec2 alignment paths';
      setCurrentModelFolder(null);
      setPreparedModelPath(null);
      setPreparedModelType('wav2vec2');
      setInitializedSummary('custom:wav2vec2');
      setInitResult(message);
      persistCache(engine, prepInfo, message);
      setIsPrepared(true);
    } catch (err) {
      const errorMessage = formatAlignmentInitError(err);
      setError(errorMessage);
      setInitResult(`Initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [
    customInitForm.fileSources,
    ensureAlignmentEngine,
    persistCache,
    releaseCurrentEngine,
  ]);

  const applySelectedModel = useCallback(() => {
    if (initMode === 'custom') {
      return applySelectedModelCustom();
    }
    return applySelectedModelAuto();
  }, [applySelectedModelAuto, applySelectedModelCustom, initMode]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick an alignment catalog folder first.');
      return;
    }

    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const modelSource = resolveModelPath(modelFolder);
      const fillResult = await fillAlignmentCustomConfigFromModelFolder(
        await toDetectSource(modelSource)
      );
      setCustomInitForm({ fileSources: fillResult.customConfig });
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
      setError(formatAlignmentInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm({ fileSources: {} });
    setCustomFillHint(
      'Scattered test: pick the wav2vec2 ONNX from a different location, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    await releaseCurrentEngine();
    setSelectedModelForInit(null);
    setCustomFillHint(null);
    setError(null);
    setCustomInitForm(DEFAULT_ALIGNMENT_CUSTOM_INIT);
    setIsPrepared(false);
  }, [releaseCurrentEngine]);

  const buildAccurateAlignmentModelArg = useCallback(():
    | {
        initMode: 'custom';
        modelType: 'wav2vec2';
        customConfig: { model: FileSource };
      }
    | { modelSource: FileSource }
    | null => {
    const cached = getAlignmentCache();
    const prep = cached.prepInfo;
    if (!prep) {
      return null;
    }
    if (prep.initMode === 'custom') {
      const model =
        prep.customConfig?.model ?? customInitForm.fileSources.model;
      if (!model) {
        return null;
      }
      return {
        initMode: 'custom' as const,
        modelType: 'wav2vec2' as const,
        customConfig: { model },
      };
    }
    if (!prep.modelFolder) {
      return null;
    }
    return { modelSource: resolveModelPath(prep.modelFolder) };
  }, [customInitForm.fileSources.model, resolveModelPath]);

  return {
    engineRef,
    catalogEntries,
    loadingModels,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    customFillLoading,
    customFillHint,
    selectedModelForInit,
    setSelectedModelForInit,
    currentModelFolder,
    preparedModelPath,
    preparedModelType,
    initializedSummary,
    initResult,
    loading,
    error,
    setError,
    isPrepared,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
    buildAccurateAlignmentModelArg,
    ensureAlignmentEngine,
  };
}
