import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertOcrCustomConfig,
  createOCR,
  detectOcrModel,
  type OcrConcreteModelType,
  type OcrCustomConfig,
  type OcrEngine,
  type OcrFamily,
  type OcrDoctrOptions,
  type OcrInitializeOptions,
  type OcrPaddleocrVlOptions,
  type OcrPpocrOptions,
} from 'react-native-sherpa-onnx/ocr';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import { clearOcrCache, getOcrCache, setOcrCache } from '../engineCache';
import type {
  ModelInitMode,
  OcrCustomInitFormState,
} from '../components/modelInit';
import {
  emptyOcrCustomInitFormState,
  fillOcrCustomConfigFromModelFolder,
} from '../utils/ocrCustomInitFill';
import {
  inferOcrFamilyFromFolder,
  isVlmOcrFamily,
} from '../utils/ocrModelCatalog';
import { useOcrModelCatalog } from './useOcrModelCatalog';
import { useDeviceProviders } from '../providers/DeviceProvidersContext';

export const OCR_MIN_THREADS = 1;
export const OCR_MAX_THREADS = 8;
export const OCR_MIN_UNCLIP = 1.0;
export const OCR_MAX_UNCLIP = 2.5;
export const OCR_DEFAULT_UNCLIP = 1.5;

function ocrDbDetectorOptions(
  detUnclipRatio: number,
  detBoxThresh: number,
  detBoxScoreThresh: number
) {
  return {
    detUnclipRatio,
    ...(detBoxThresh > 0 ? { detBoxThresh } : {}),
    ...(detBoxScoreThresh > 0 ? { detBoxScoreThresh } : {}),
  };
}

function familyInitExtras(
  family: OcrFamily | null,
  args: {
    detUnclipRatio: number;
    detBoxThresh: number;
    detBoxScoreThresh: number;
    maxNewTokens: number;
    maxPixels: number;
    maxSideLen: number;
    useOrientationCls: boolean;
  }
): {
  maxNewTokens?: number;
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  paddleocrVl?: OcrPaddleocrVlOptions;
} {
  const db = ocrDbDetectorOptions(
    args.detUnclipRatio,
    args.detBoxThresh,
    args.detBoxScoreThresh
  );
  if (family === 'ppocr') {
    return {
      ppocr: {
        ...db,
        ...(args.maxSideLen > 0 ? { maxSideLen: args.maxSideLen } : {}),
        useOrientationCls: args.useOrientationCls,
      },
    };
  }
  if (family === 'doctr') {
    return { doctr: db };
  }
  if (family === 'paddleocr_vl') {
    return {
      maxNewTokens: args.maxNewTokens,
      paddleocrVl: { maxPixels: args.maxPixels },
    };
  }
  if (isVlmOcrFamily(family)) {
    return { maxNewTokens: args.maxNewTokens };
  }
  return {};
}

export function clampOcrUnclipRatio(value: number): number {
  const clamped = Math.min(OCR_MAX_UNCLIP, Math.max(OCR_MIN_UNCLIP, value));
  return Math.round(clamped * 20) / 20;
}

export function asOcrFamily(
  value: string | undefined | null
): OcrConcreteModelType | null {
  if (
    value === 'ppocr' ||
    value === 'doctr' ||
    value === 'doc_vlm' ||
    value === 'nemotron_parse' ||
    value === 'paddleocr_vl'
  ) {
    return value;
  }
  return null;
}

function largeVlmPackWarning(id: string): string | null {
  const lower = id.toLowerCase();
  if (lower.includes('docvlm') || lower.includes('granite')) {
    if (lower.includes('q4f16')) {
      return 'docvlm-granite-258m-q4f16 is ~221 MiB compressed / ~265 MB unpacked (Float16 KV + MatMulNBits). Mobile ORT must include com.microsoft.GroupQueryAttention. Continue?';
    }
    return 'docvlm-granite-258m is ~420 MiB compressed / ~1.2 GiB unpacked and needs significant RAM. Mobile ORT must include com.microsoft.GroupQueryAttention. Continue?';
  }
  if (
    lower.includes('nemotron-3.5-parse') ||
    lower.includes('nemotron-parse') ||
    lower.includes('nemotron_parse')
  ) {
    return 'nemotron-3.5-parse INT8 is ~753 MB unpacked (FP16 ~1.44 GB) and needs significant RAM. Continue?';
  }
  if (lower.includes('paddleocr-vl') || lower.includes('paddleocr_vl')) {
    return 'paddleocr-vl-1.6 FP16 is ~1.8 GB unpacked. Use provider CPU (XNNPACK fails init: fp16 FastGelu). On phones set paddleocrVl.maxPixels to 401408 and maxNewTokens 512. Continue?';
  }
  return null;
}

export type UseOcrModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useOcrModelInit(options: UseOcrModelInitOptions = {}) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useOcrModelCatalog();
  const { selectableApiIds: providerOptions, status: providerStatus } =
    useDeviceProviders();
  const providersLoading =
    providerStatus === 'loading' || providerStatus === 'idle';

  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [initializedFolder, setInitializedFolder] = useState<string | null>(
    null
  );
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<OcrCustomInitFormState>(
    () => emptyOcrCustomInitFormState()
  );
  const [fillLoading, setFillLoading] = useState(false);
  const [fillHint, setFillHint] = useState<string | null>(null);
  const [numThreads, setNumThreads] = useState(2);
  const [provider, setProvider] = useState('cpu');
  const [detUnclipRatio, setDetUnclipRatio] = useState(OCR_DEFAULT_UNCLIP);
  const [detBoxThresh, setDetBoxThresh] = useState(0);
  const [detBoxScoreThresh, setDetBoxScoreThresh] = useState(0);
  const [maxSideLen, setMaxSideLen] = useState(0);
  const [useOrientationCls, setUseOrientationCls] = useState(true);

  const selectedFamily = useMemo<OcrFamily | null>(() => {
    if (initMode === 'custom') {
      return customInitForm.modelType;
    }
    return selectedFolder ? inferOcrFamilyFromFolder(selectedFolder) : null;
  }, [customInitForm.modelType, initMode, selectedFolder]);
  const [initBusy, setInitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initMessage, setInitMessage] = useState<string | null>(null);
  const [detectSummary, setDetectSummary] = useState<string | null>(null);
  const [engineFamily, setEngineFamily] = useState<OcrConcreteModelType | null>(
    null
  );
  const engineRef = useRef<OcrEngine | null>(null);

  useEffect(() => {
    if (selectedFolder && catalogEntries.some((e) => e.id === selectedFolder)) {
      return;
    }
    const tiny = catalogEntries.find((e) =>
      e.id.toLowerCase().includes('ppocrv6-tiny')
    );
    setSelectedFolder(tiny?.id ?? catalogEntries[0]?.id ?? null);
  }, [catalogEntries, selectedFolder]);

  useEffect(() => {
    if (catalogError) {
      setError(catalogError);
    }
  }, [catalogError]);

  useEffect(() => {
    if (providerOptions.length === 0) {
      setProvider('cpu');
      return;
    }
    setProvider((prev) =>
      providerOptions.includes(prev) ? prev : providerOptions[0]!
    );
  }, [providerOptions]);

  useEffect(() => {
    const cached = getOcrCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setInitializedFolder(cached.modelFolder);
      setEngineFamily(cached.engineFamily);
      setInitMessage(cached.initMessage);
      setDetectSummary(cached.detectSummary);
      if (!cached.modelFolder.startsWith('custom:')) {
        setSelectedFolder(cached.modelFolder);
      }
    }
  }, []);

  const releaseEngine = useCallback(async () => {
    await onBeforeInitRef.current?.();
    const engine = engineRef.current;
    engineRef.current = null;
    clearOcrCache();
    setInitializedFolder(null);
    setInitMessage(null);
    setDetectSummary(null);
    setEngineFamily(null);
    if (engine) {
      await engine.destroy().catch(() => {});
    }
  }, []);

  const runDetect = useCallback(
    async (modelId: string) => {
      const modelSource = await toDetectSource(resolveModelPath(modelId));
      const det = await detectOcrModel(modelSource, { modelType: 'auto' });
      setDetectSummary(
        det.success
          ? `detect: modelType=${det.modelType ?? '?'}`
          : `detect failed: ${det.error ?? 'unknown'}`
      );
      return det;
    },
    [resolveModelPath]
  );

  const fillFromSelectedModel = useCallback(async () => {
    if (!selectedFolder) {
      Alert.alert('Select a model', 'Pick an OCR pack from the catalog first.');
      return;
    }
    setFillLoading(true);
    setFillHint(null);
    setError(null);
    try {
      const fillResult = await fillOcrCustomConfigFromModelFolder(
        await toDetectSource(resolveModelPath(selectedFolder))
      );
      setCustomInitForm((prev) => ({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
        maxNewTokens: prev.maxNewTokens,
        maxPixels: prev.maxPixels,
        detBoxThresh: prev.detBoxThresh,
        detBoxScoreThresh: prev.detBoxScoreThresh,
      }));
      const missing =
        fillResult.missingKeys.length > 0
          ? ` Missing: ${fillResult.missingKeys.join(', ')}`
          : '';
      setFillHint(
        `Filled from ${getModelDisplayName(selectedFolder)}.${missing}`
      );
    } catch (err) {
      setFillHint(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFillLoading(false);
    }
  }, [resolveModelPath, selectedFolder]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setFillHint(
      'Scattered test: pick required slots manually, then Initialize.'
    );
  }, []);

  const initializeAuto = useCallback(
    async (folderId: string) => {
      const threads = Math.min(
        OCR_MAX_THREADS,
        Math.max(OCR_MIN_THREADS, numThreads)
      );
      const providerValue = provider.trim() || 'cpu';
      setInitBusy(true);
      setError(null);
      setInitMessage(null);
      try {
        await onBeforeInitRef.current?.();
        const previous = engineRef.current;
        if (previous) {
          engineRef.current = null;
          clearOcrCache();
          await previous.destroy().catch(() => {});
        }
        const modelSource = await toDetectSource(resolveModelPath(folderId));
        const det = await runDetect(folderId);
        const summary = det.success
          ? `detect: modelType=${det.modelType ?? '?'}`
          : `detect failed: ${det.error ?? 'unknown'}`;
        const familyForInit =
          inferOcrFamilyFromFolder(folderId) ??
          asOcrFamily(det.success ? det.modelType : null);
        const maxLabel =
          customInitForm.maxNewTokens === 0
            ? 'default'
            : String(customInitForm.maxNewTokens);
        const initOptions = {
          modelSource,
          modelType: familyForInit ?? 'auto',
          provider: providerValue,
          numThreads: threads,
          ...familyInitExtras(familyForInit, {
            detUnclipRatio,
            detBoxThresh,
            detBoxScoreThresh,
            maxNewTokens: customInitForm.maxNewTokens,
            maxPixels: customInitForm.maxPixels,
            maxSideLen,
            useOrientationCls,
          }),
        } as OcrInitializeOptions;
        const ocr = await createOCR(initOptions);
        engineRef.current = ocr;
        const family =
          asOcrFamily(det.success ? det.modelType : null) ?? familyForInit;
        const message = `Ready · instance=${ocr.instanceId} · modelType=${
          familyForInit ?? 'auto'
        } · ${getModelDisplayName(folderId)}${
          isVlmOcrFamily(familyForInit) ? ` · maxNewTokens=${maxLabel}` : ''
        }`;
        setEngineFamily(family);
        setInitializedFolder(folderId);
        setInitMessage(message);
        setOcrCache(ocr, folderId, family, message, summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInitBusy(false);
      }
    },
    [
      resolveModelPath,
      customInitForm.maxNewTokens,
      customInitForm.maxPixels,
      detUnclipRatio,
      detBoxThresh,
      detBoxScoreThresh,
      maxSideLen,
      useOrientationCls,
      numThreads,
      provider,
      runDetect,
    ]
  );

  const initializeCustom = useCallback(async () => {
    const threads = Math.min(
      OCR_MAX_THREADS,
      Math.max(OCR_MIN_THREADS, numThreads)
    );
    const providerValue = provider.trim() || 'cpu';
    setInitBusy(true);
    setError(null);
    setInitMessage(null);
    try {
      await onBeforeInitRef.current?.();
      const previous = engineRef.current;
      if (previous) {
        engineRef.current = null;
        clearOcrCache();
        await previous.destroy().catch(() => {});
      }
      const customConfig = {
        ...customInitForm.fileSources,
      } as OcrCustomConfig;
      assertOcrCustomConfig(customConfig as unknown as Record<string, unknown>);
      const family = customInitForm.modelType;
      const extras = familyInitExtras(family, {
        detUnclipRatio,
        detBoxThresh,
        detBoxScoreThresh,
        maxNewTokens: customInitForm.maxNewTokens,
        maxPixels: customInitForm.maxPixels,
        maxSideLen,
        useOrientationCls,
      });
      const ocr = await createOCR({
        initMode: 'custom',
        customConfig,
        provider: providerValue,
        numThreads: threads,
        modelType: family,
        ...extras,
      } as OcrInitializeOptions);
      engineRef.current = ocr;
      const folder = selectedFolder
        ? `custom:${selectedFolder}`
        : `custom:${family}`;
      const maxLabel =
        customInitForm.maxNewTokens === 0
          ? 'default'
          : String(customInitForm.maxNewTokens);
      const message = `Ready · instance=${ocr.instanceId} · custom:${family}${
        isVlmOcrFamily(family) ? ` · maxNewTokens=${maxLabel}` : ''
      }`;
      setEngineFamily(family);
      setInitializedFolder(folder);
      setInitMessage(message);
      setOcrCache(ocr, folder, family, message, detectSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  }, [
    customInitForm.fileSources,
    customInitForm.maxNewTokens,
    customInitForm.maxPixels,
    customInitForm.modelType,
    detectSummary,
    detUnclipRatio,
    detBoxThresh,
    detBoxScoreThresh,
    maxSideLen,
    useOrientationCls,
    numThreads,
    provider,
    selectedFolder,
  ]);

  const applySelectedModel = useCallback(async () => {
    if (initMode === 'custom') {
      await initializeCustom();
      return;
    }
    if (!selectedFolder) {
      setError('Select an OCR pack (assets, PAD, or Download Manager → OCR).');
      return;
    }
    const vlmWarning = largeVlmPackWarning(selectedFolder);
    if (vlmWarning) {
      Alert.alert('Large VLM pack', vlmWarning, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Initialize',
          onPress: () => {
            initializeAuto(selectedFolder).catch(() => {});
          },
        },
      ]);
      return;
    }
    await initializeAuto(selectedFolder);
  }, [initMode, initializeAuto, initializeCustom, selectedFolder]);

  const isEngineInitialized = initializedFolder != null;

  return {
    engineRef,
    catalogEntries,
    loadingModels,
    selectedFolder,
    setSelectedFolder,
    initializedFolder,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    fillLoading,
    fillHint,
    fillFromSelectedModel,
    prepareScatteredTest,
    numThreads,
    setNumThreads,
    provider,
    setProvider,
    providerOptions,
    providersLoading,
    selectedFamily,
    detUnclipRatio,
    setDetUnclipRatio,
    detBoxThresh,
    setDetBoxThresh,
    detBoxScoreThresh,
    setDetBoxScoreThresh,
    maxSideLen,
    setMaxSideLen,
    useOrientationCls,
    setUseOrientationCls,
    initBusy,
    error,
    setError,
    initMessage,
    detectSummary,
    engineFamily,
    isEngineInitialized,
    applySelectedModel,
    releaseEngine,
  };
}
