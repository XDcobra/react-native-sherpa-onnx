import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { readFile } from '@dr.pogodin/react-native-fs';
import {
  createKeywordSpotting,
  detectKwsModel,
  type KeywordSpottingEngine,
} from 'react-native-sherpa-onnx/kws';
import { getModelDisplayName } from '../modelConfig';
import { clearKwsCache, getKwsCache, setKwsCache } from '../engineCache';
import type {
  KwsCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import {
  emptyKwsCustomInitFormState,
  fillKwsCustomConfigFromModelFolder,
} from '../utils/kwsCustomInitFill';
import { useKwsModelCatalog } from './useKwsModelCatalog';

export function formatKwsInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  return typeof err === 'string' ? err : String(err);
}

export type UseKwsModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  /** Invoked when Fill loads pack keywords.txt into the session override. */
  onPackKeywordsLoaded?: (text: string) => void;
  /** Invoked when catalog selection changes (e.g. clear keywords override). */
  onSelectedModelChanged?: (modelId: string | null) => void;
  /** Optional line-count hint for init summary (spot override textarea). */
  getKeywordsOverrideLineCount?: () => number;
};

export function useKwsModelInit(options: UseKwsModelInitOptions = {}) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onPackKeywordsLoadedRef = useRef(options.onPackKeywordsLoaded);
  onPackKeywordsLoadedRef.current = options.onPackKeywordsLoaded;
  const onSelectedModelChangedRef = useRef(options.onSelectedModelChanged);
  onSelectedModelChangedRef.current = options.onSelectedModelChanged;
  const getKeywordsOverrideLineCountRef = useRef(
    options.getKeywordsOverrideLineCount
  );
  getKeywordsOverrideLineCountRef.current =
    options.getKeywordsOverrideLineCount;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useKwsModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<KwsCustomInitFormState>(
    emptyKwsCustomInitFormState()
  );
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedModelForInit, setSelectedModelForInitState] = useState<
    string | null
  >(null);
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [keywordsScore, setKeywordsScore] = useState('1.5');
  const [keywordsThreshold, setKeywordsThreshold] = useState('0.25');
  const [numTrailingBlanks, setNumTrailingBlanks] = useState('2');
  const [maxActivePaths, setMaxActivePaths] = useState('4');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<KeywordSpottingEngine | null>(null);
  const isEngineInitialized = initializedSummary != null;

  const setSelectedModelForInit = useCallback((modelId: string | null) => {
    setSelectedModelForInitState(modelId);
    onSelectedModelChangedRef.current?.(modelId);
  }, []);

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
    const next = catalogEntries[0]?.id ?? null;
    setSelectedModelForInitState(next);
  }, [catalogEntries, selectedModelForInit]);

  useEffect(() => {
    const cached = getKwsCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInitState(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? 'custom'
          : getModelDisplayName(cached.modelFolder)
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    engineRef.current = null;
    clearKwsCache();
  }, []);

  const buildTuning = useCallback(() => {
    const score = Number.parseFloat(keywordsScore);
    const threshold = Number.parseFloat(keywordsThreshold);
    const trailing = Number.parseInt(numTrailingBlanks, 10);
    const paths = Number.parseInt(maxActivePaths, 10);
    return {
      keywordsScore: Number.isFinite(score) ? score : 1.5,
      keywordsThreshold: Number.isFinite(threshold) ? threshold : 0.25,
      numTrailingBlanks: Number.isFinite(trailing) ? trailing : 2,
      maxActivePaths: Number.isFinite(paths) ? paths : 4,
    };
  }, [keywordsScore, keywordsThreshold, maxActivePaths, numTrailingBlanks]);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert('Select a model', 'Pick a KWS pack first.');
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
        const det = await detectKwsModel(modelSource);
        if (!det.success) {
          throw new Error(det.error ?? 'detectKwsModel failed');
        }
        if (!det.isStreaming) {
          throw new Error('Detected pack is not streaming KWS');
        }
        const eng = await createKeywordSpotting({
          modelSource,
          ...buildTuning(),
        });
        engineRef.current = eng;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInitState(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const overrideLines = getKeywordsOverrideLineCountRef.current?.() ?? 0;
        const kwNote =
          overrideLines > 0
            ? `init=pack keywords.txt; spot override=${overrideLines} lines`
            : 'init=pack keywords.txt (textarea empty → pack on spot)';
        const message =
          `Initialized (auto): ${summary}\n` +
          `Detected: ${det.modelType ?? 'transducer'} · streaming=${String(
            det.isStreaming
          )}${det.quantization ? ` · ${det.quantization}` : ''}\n` +
          `instance: ${eng.instanceId}\n` +
          kwNote;
        setInitializedSummary(summary);
        setInitResult(message);
        setKwsCache(eng, modelFolder, message);
      } catch (err) {
        const errorMessage = formatKwsInitError(err);
        setError(errorMessage);
        setInitResult(null);
      } finally {
        setLoading(false);
      }
    },
    [buildTuning, releaseCurrentEngine, resolveModelPath]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const {
        encoder,
        decoder,
        joiner,
        tokens,
        keywords: keywordsFile,
      } = customInitForm.fileSources;
      const missing = (
        [
          ['encoder', encoder],
          ['decoder', decoder],
          ['joiner', joiner],
          ['tokens', tokens],
          ['keywords', keywordsFile],
        ] as const
      )
        .filter(([, src]) => !src)
        .map(([key]) => key);
      if (missing.length > 0) {
        throw new Error(
          `Custom init missing required paths: ${missing.join(', ')}`
        );
      }
      const eng = await createKeywordSpotting({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig: {
          encoder: encoder!,
          decoder: decoder!,
          joiner: joiner!,
          tokens: tokens!,
          keywords: keywordsFile!,
        },
        ...buildTuning(),
      });
      engineRef.current = eng;
      setCurrentModelFolder(null);
      const summary = selectedModelForInit
        ? getModelDisplayName(selectedModelForInit)
        : 'custom paths';
      const overrideLines = getKeywordsOverrideLineCountRef.current?.() ?? 0;
      const kwNote =
        overrideLines > 0
          ? `init=pack keywords.txt; spot override=${overrideLines} lines`
          : 'init=pack keywords.txt (textarea empty → pack on spot)';
      const message =
        `Initialized (custom): ${summary}\n` +
        `Detected: transducer · streaming=true\n` +
        `instance: ${eng.instanceId}\n` +
        kwNote;
      setInitializedSummary(summary);
      setInitResult(message);
      setKwsCache(eng, 'custom', message);
    } catch (err) {
      const errorMessage = formatKwsInitError(err);
      setError(errorMessage);
      setInitResult(null);
    } finally {
      setLoading(false);
    }
  }, [
    buildTuning,
    customInitForm.fileSources,
    customInitForm.modelType,
    releaseCurrentEngine,
    selectedModelForInit,
  ]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a KWS pack first.');
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const source = resolveModelPath(modelFolder);
      const res = await fillKwsCustomConfigFromModelFolder(source);
      setCustomInitForm({
        modelType: 'transducer',
        fileSources: res.customConfig,
      });
      setCustomFillHint(`Filled paths from ${modelFolder}`);
      const keywordsPath = res.customConfig.keywords;
      if (keywordsPath?.kind === 'fs' && keywordsPath.path) {
        try {
          const body = await readFile(keywordsPath.path, 'utf8');
          onPackKeywordsLoadedRef.current?.(body);
        } catch {
          // ignore read failures
        }
      }
    } catch (err) {
      const msg = formatKwsInitError(err);
      setCustomFillHint(`Fill failed: ${msg}`);
      setError(msg);
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch {
        // ignore
      }
      engineRef.current = null;
    }
    clearKwsCache();
    setCurrentModelFolder(null);
    setSelectedModelForInitState(null);
    setInitResult(null);
    setInitializedSummary(null);
    setCustomFillHint(null);
    setError(null);
  }, []);

  const applySelectedModel = useCallback(() => {
    if (initMode === 'custom') {
      return initializeCustom();
    }
    return initializeAuto(selectedModelForInit ?? currentModelFolder ?? '');
  }, [
    currentModelFolder,
    initMode,
    initializeAuto,
    initializeCustom,
    selectedModelForInit,
  ]);

  return {
    engineRef,
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
    keywordsScore,
    setKeywordsScore,
    keywordsThreshold,
    setKeywordsThreshold,
    numTrailingBlanks,
    setNumTrailingBlanks,
    maxActivePaths,
    setMaxActivePaths,
    loading,
    error,
    setError,
    isEngineInitialized,
    applySelectedModel,
    fillFromSelectedModel,
    releaseEngine,
  };
}
