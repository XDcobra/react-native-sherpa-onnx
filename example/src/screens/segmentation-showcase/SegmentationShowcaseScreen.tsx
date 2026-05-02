import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
  FlatList,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import type { ModelPathConfig } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  getSegmentCount,
  getSegments,
  segmentOfflineBuffer,
  type SpeechSegment,
  type TextSegment,
} from 'react-native-sherpa-onnx/segment';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createOfflinePunctuation,
  detectPunctuationModel,
  type OfflinePunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import {
  detectVadModel,
  type VADModelType,
} from 'react-native-sherpa-onnx/vad';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
  type ModelMeta,
} from 'react-native-sherpa-onnx/download';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES } from '../../audioConfig';
import { RECOMMENDED_MODEL_IDS } from '../../utils/recommendedModels';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  getColorForSegmentReason,
  SEGMENT_REASON_BADGE_LABEL_COLOR,
} from './segmentReasonColors';
import { styles } from './SegmentationShowcaseScreen.styles';

type Mode = 'text' | 'audio';
type TextEvaluator = 'text_synthetic_auto' | 'text_punctuation_assisted';
type AudioEvaluator = 'speech_energy_silence' | 'speech_vad_model';

type ModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

type TextSegmentationState = {
  evaluator: TextEvaluator;
  inputText: string;
  segments: TextSegment[];
  /** From `getSegmentCount` after the last run; drives “Show more” paging. */
  totalSegmentCount: number | null;
  maxLengthChars: number;
  sentenceBoundary: boolean;
  useCustomSentenceBoundaryChars: boolean;
  /** Pipe-separated delimiter strings (`\\n` → newline). Used when useCustomSentenceBoundaryChars. */
  sentenceBoundaryCharsInput: string;
  selectedPunctuationModelId: string | null;
  initializedPunctuationModelId: string | null;
  initializedPunctuationInstanceId: string | null;
};

type AudioSegmentationState = {
  evaluator: AudioEvaluator;
  audioFile: { uri: string; name: string } | null;
  segments: SpeechSegment[];
  /** From `getSegmentCount` after the last run; drives “Show more” paging. */
  totalSegmentCount: number | null;
  silenceThresholdMs: number;
  /** Raw text for decimal-pad input (allows ".", "-0.", etc. while typing). */
  energyThresholdDb: string;
  minSegmentMs: number;
  maxSegmentMs: number;
  hangoverMs: number;
  /** Raw text for decimal-pad input. */
  vadThreshold: string;
  vadMinSpeechMs: number;
  vadMinSilenceMs: number;
  selectedVadModelId: string | null;
  initializedVadModelId: string | null;
  initializedVadModelPath: string | null;
  /** Resolved {@link FileSource} passed to `speech_vad_model` policy (same as detectVadModel input). */
  initializedVadFileSource: FileSource | null;
  detectedVadModelType: VADModelType | null;
};

const EXAMPLE_TEXT =
  'Hello world. This is a longer example text that will be segmented. The segmentation engine cuts text at sentence boundaries and respects length limits. You can adjust parameters to see how segments change.';
const SEGMENT_PAGE_SIZE = 128;

const PAD_PACK_NAME = 'sherpa_models';
const RECOMMENDED_VAD_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Vad] ?? [];

function parseSentenceBoundaryCharsInput(raw: string): string[] {
  return raw
    .split('|')
    .map((part) => part.trim().replace(/\\n/g, '\n'))
    .filter((s) => s.length > 0);
}

/** Parse at run time; invalid / empty uses fallback. */
function parseOptionalFloat(raw: string, fallback: number): number {
  const n = parseFloat(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return 'Unknown error';
}

function isPunctuationNameCandidate(folder: string): boolean {
  const normalized = folder.toLowerCase();
  return (
    normalized.includes('punct') ||
    normalized.includes('punctuation') ||
    normalized.includes('ct-transform') ||
    normalized.includes('ct_transformer')
  );
}

function isVadModelFolder(folder: string, hint: string): boolean {
  if (hint === 'vad') {
    return true;
  }
  const normalized = folder.toLowerCase();
  return (
    normalized.includes('vad') ||
    normalized.includes('silero') ||
    normalized.includes('ten-vad')
  );
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: ModelEntry[],
  recommendedIds: string[] = []
): ModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: ModelEntry[] = [];
  const remaining: ModelEntry[] = [];

  for (const entry of uniqueEntries) {
    if (recommendedSet.has(entry.id)) {
      recommended.push({ ...entry, recommended: true });
      continue;
    }
    remaining.push(entry);
  }

  recommended.sort(
    (left, right) =>
      recommendedIds.indexOf(left.id) - recommendedIds.indexOf(right.id)
  );
  remaining.sort((left, right) => left.label.localeCompare(right.label));

  return [...recommended, ...remaining];
}

async function folderIsOfflineCtTransformer(
  modelPath: ModelPathConfig
): Promise<boolean> {
  try {
    const detection = await detectPunctuationModel(
      await toDetectSource(modelPath),
      {
        modelType: 'ct_transformer',
      }
    );
    return detection.success && detection.modelType === 'ct_transformer';
  } catch {
    return false;
  }
}

function resolvePunctuationModelPathFromScan(
  modelId: string,
  downloadedIds: string[],
  padIds: string[],
  padBasePath: string | null
): ModelPathConfig {
  if (downloadedIds.includes(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Punctuation);
  }
  if (padIds.includes(modelId) && padBasePath) {
    return getFileModelPath(modelId, ModelCategory.Punctuation, padBasePath);
  }
  return getAssetModelPath(modelId);
}

function getVadModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
  }
): ModelPathConfig {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Vad, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Vad);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Vad);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export default function SegmentationShowcaseScreen() {
  const [mode, setMode] = useState<Mode>('text');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingPunctuationModels, setLoadingPunctuationModels] =
    useState(false);
  const [loadingVadModels, setLoadingVadModels] = useState(false);
  const [initializingPunctuation, setInitializingPunctuation] = useState(false);
  const [initializingVadModel, setInitializingVadModel] = useState(false);
  const [punctuationStatus, setPunctuationStatus] = useState<string | null>(
    null
  );
  const [vadStatus, setVadStatus] = useState<string | null>(null);
  const [availablePunctuationModels, setAvailablePunctuationModels] = useState<
    ModelEntry[]
  >([]);
  const [availableVadModels, setAvailableVadModels] = useState<ModelEntry[]>(
    []
  );
  const [padPunctuationModelIds, setPadPunctuationModelIds] = useState<
    string[]
  >([]);
  const [downloadedPunctuationModelIds, setDownloadedPunctuationModelIds] =
    useState<string[]>([]);
  const [padVadModelIds, setPadVadModelIds] = useState<string[]>([]);
  const [bundledVadFolders, setBundledVadFolders] = useState<string[]>([]);
  const [downloadedVadIds, setDownloadedVadIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);

  const [loadingMoreSegments, setLoadingMoreSegments] = useState(false);

  const [textState, setTextState] = useState<TextSegmentationState>({
    evaluator: 'text_synthetic_auto',
    inputText: EXAMPLE_TEXT,
    segments: [],
    totalSegmentCount: null,
    maxLengthChars: 100,
    sentenceBoundary: true,
    useCustomSentenceBoundaryChars: false,
    sentenceBoundaryCharsInput: '. | ! | ? | ; | : | \\n',
    selectedPunctuationModelId: null,
    initializedPunctuationModelId: null,
    initializedPunctuationInstanceId: null,
  });

  const [audioState, setAudioState] = useState<AudioSegmentationState>({
    evaluator: 'speech_energy_silence',
    audioFile: null,
    segments: [],
    totalSegmentCount: null,
    silenceThresholdMs: 500,
    energyThresholdDb: '-40',
    minSegmentMs: 1000,
    maxSegmentMs: 30000,
    hangoverMs: 300,
    vadThreshold: '0.5',
    vadMinSpeechMs: 250,
    vadMinSilenceMs: 250,
    selectedVadModelId: null,
    initializedVadModelId: null,
    initializedVadModelPath: null,
    initializedVadFileSource: null,
    detectedVadModelType: null,
  });
  const [preparedAudioBuffer, setPreparedAudioBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const audioWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  const textBufferRef = useRef<string | null>(null);
  const audioBufferRef = useRef<string | null>(null);
  const punctuationEngineRef = useRef<OfflinePunctuationEngine | null>(null);

  const resolvePunctuationModelPath = useCallback(
    (modelId: string): ModelPathConfig => {
      if (downloadedPunctuationModelIds.includes(modelId)) {
        return getFileModelPath(modelId, ModelCategory.Punctuation);
      }
      if (padPunctuationModelIds.includes(modelId) && padModelsPath) {
        return getFileModelPath(
          modelId,
          ModelCategory.Punctuation,
          padModelsPath
        );
      }
      return getAssetModelPath(modelId);
    },
    [downloadedPunctuationModelIds, padModelsPath, padPunctuationModelIds]
  );

  const loadAvailablePunctuationModels = useCallback(async () => {
    setLoadingPunctuationModels(true);
    try {
      const [assetModels, downloadedList] = await Promise.all([
        listAssetModels(),
        listDownloadedModels(ModelCategory.Punctuation),
      ]);

      const assetIds = assetModels
        .map((model) => model.folder)
        .filter(isPunctuationNameCandidate);
      const downloadedIds = downloadedList.map((model) => model.id);

      let padIds: string[] = [];
      let resolvedPadPath: string | null = null;

      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const basePath = padPathFromNative ?? fallbackPath;
        const padModels = await listModelsAtPath(basePath);
        padIds = (padModels || [])
          .map((model) => model.folder)
          .filter(isPunctuationNameCandidate);
        if (padIds.length > 0) {
          resolvedPadPath = basePath;
        }
      } catch {
        padIds = [];
      }

      const combinedIds = Array.from(
        new Set([
          ...downloadedIds,
          ...assetIds,
          ...padIds.filter(
            (modelId) =>
              !downloadedIds.includes(modelId) && !assetIds.includes(modelId)
          ),
        ])
      );

      const supportedIds: string[] = [];
      for (const modelId of combinedIds) {
        const modelPath = resolvePunctuationModelPathFromScan(
          modelId,
          downloadedIds,
          padIds,
          resolvedPadPath
        );
        if (await folderIsOfflineCtTransformer(modelPath)) {
          supportedIds.push(modelId);
        }
      }

      const entries = supportedIds.map((id) => ({
        id,
        label: getModelDisplayName(id),
      }));

      setPadModelsPath((current) => current ?? resolvedPadPath);
      setPadPunctuationModelIds(padIds);
      setDownloadedPunctuationModelIds(downloadedIds);
      setAvailablePunctuationModels(entries);
      setTextState((prev) => {
        const selectedPunctuationModelId =
          prev.selectedPunctuationModelId &&
          supportedIds.includes(prev.selectedPunctuationModelId)
            ? prev.selectedPunctuationModelId
            : supportedIds[0] ?? null;
        const initializedStillAvailable =
          prev.initializedPunctuationModelId &&
          supportedIds.includes(prev.initializedPunctuationModelId);
        return {
          ...prev,
          selectedPunctuationModelId,
          initializedPunctuationModelId: initializedStillAvailable
            ? prev.initializedPunctuationModelId
            : null,
          initializedPunctuationInstanceId: initializedStillAvailable
            ? prev.initializedPunctuationInstanceId
            : null,
        };
      });
      if (
        textState.initializedPunctuationModelId &&
        !supportedIds.includes(textState.initializedPunctuationModelId)
      ) {
        setPunctuationStatus(null);
      }
    } catch (err) {
      console.error(
        'SegmentationShowcaseScreen: failed to load punctuation models',
        err
      );
      setAvailablePunctuationModels([]);
      setPadPunctuationModelIds([]);
      setDownloadedPunctuationModelIds([]);
      setTextState((prev) => ({
        ...prev,
        selectedPunctuationModelId: null,
        initializedPunctuationModelId: null,
        initializedPunctuationInstanceId: null,
      }));
    } finally {
      setLoadingPunctuationModels(false);
    }
  }, [textState.initializedPunctuationModelId]);

  const loadAvailableVadModels = useCallback(async () => {
    setLoadingVadModels(true);
    try {
      const assetModels = await listAssetModels();
      const bundledIds = assetModels
        .filter((model) => isVadModelFolder(model.folder, model.hint))
        .map((model) => model.folder);

      let resolvedPadPath: string | null = null;
      let padIds: string[] = [];
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const basePath = padPathFromNative ?? fallbackPath;
        const padModels = await listModelsAtPath(basePath);
        padIds = (padModels || [])
          .filter((model) => isVadModelFolder(model.folder, model.hint))
          .map((model) => model.folder);
        if (padIds.length > 0) {
          resolvedPadPath = basePath;
        }
      } catch {
        padIds = [];
      }

      const downloaded = await listDownloadedModels(ModelCategory.Vad);
      const downloadedIds = downloaded.map((model) => model.id);
      const metaById = new Map(
        downloaded.map((model) => [model.id, model] as const)
      );

      const combinedIds: string[] = [];
      const pushId = (id: string) => {
        if (!combinedIds.includes(id)) {
          combinedIds.push(id);
        }
      };
      for (const id of padIds) {
        pushId(id);
      }
      for (const id of bundledIds) {
        pushId(id);
      }
      for (const id of downloadedIds) {
        pushId(id);
      }

      const entries = prioritizeEntries(
        combinedIds.map((id) => {
          const meta = metaById.get(id);
          return {
            id,
            label: meta ? getModelLabel(meta) : getModelDisplayName(id),
          };
        }),
        RECOMMENDED_VAD_MODEL_IDS
      );

      setPadModelsPath((current) => current ?? resolvedPadPath);
      setPadVadModelIds(padIds);
      setBundledVadFolders(bundledIds);
      setDownloadedVadIds(downloadedIds);
      setAvailableVadModels(entries);
      const supportedIds = entries.map((entry) => entry.id);
      setAudioState((prev) => {
        const selectedVadModelId =
          prev.selectedVadModelId &&
          supportedIds.includes(prev.selectedVadModelId)
            ? prev.selectedVadModelId
            : supportedIds[0] ?? null;
        const initializedStillAvailable =
          prev.initializedVadModelId &&
          supportedIds.includes(prev.initializedVadModelId);
        return {
          ...prev,
          selectedVadModelId,
          initializedVadModelId: initializedStillAvailable
            ? prev.initializedVadModelId
            : null,
          initializedVadModelPath: initializedStillAvailable
            ? prev.initializedVadModelPath
            : null,
          initializedVadFileSource: initializedStillAvailable
            ? prev.initializedVadFileSource
            : null,
          detectedVadModelType: initializedStillAvailable
            ? prev.detectedVadModelType
            : null,
        };
      });
      if (
        audioState.initializedVadModelId &&
        !supportedIds.includes(audioState.initializedVadModelId)
      ) {
        setVadStatus(null);
      }
    } catch (err) {
      console.error(
        'SegmentationShowcaseScreen: failed to load VAD models',
        err
      );
      setAvailableVadModels([]);
      setPadVadModelIds([]);
      setBundledVadFolders([]);
      setDownloadedVadIds([]);
      setAudioState((prev) => ({
        ...prev,
        selectedVadModelId: null,
        initializedVadModelId: null,
        initializedVadModelPath: null,
        initializedVadFileSource: null,
        detectedVadModelType: null,
      }));
    } finally {
      setLoadingVadModels(false);
    }
  }, [audioState.initializedVadModelId]);

  useEffect(() => {
    loadAvailablePunctuationModels().catch(() => {});
    loadAvailableVadModels().catch(() => {});
  }, [loadAvailablePunctuationModels, loadAvailableVadModels]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category === ModelCategory.Punctuation) {
        loadAvailablePunctuationModels().catch(() => {});
      }
      if (category === ModelCategory.Vad) {
        loadAvailableVadModels().catch(() => {});
      }
    });

    return unsubscribe;
  }, [loadAvailablePunctuationModels, loadAvailableVadModels]);

  useEffect(() => {
    return () => {
      if (textBufferRef.current) {
        releasePipelineTextBuffer(textBufferRef.current).catch(() => {});
      }
      if (audioBufferRef.current) {
        releasePipelineAudioBuffer(audioBufferRef.current).catch(() => {});
      }
      if (punctuationEngineRef.current) {
        punctuationEngineRef.current.destroy().catch(() => {});
        punctuationEngineRef.current = null;
      }
    };
  }, []);

  const handleInitializePunctuation = useCallback(async () => {
    if (!textState.selectedPunctuationModelId) {
      setError('Select a punctuation model first.');
      return;
    }

    setInitializingPunctuation(true);
    setError(null);
    setPunctuationStatus(null);

    try {
      if (punctuationEngineRef.current) {
        await punctuationEngineRef.current.destroy().catch(() => {});
        punctuationEngineRef.current = null;
      }

      const engine = await createOfflinePunctuation({
        modelPath: resolvePunctuationModelPath(
          textState.selectedPunctuationModelId
        ),
        modelType: 'auto',
        numThreads: 1,
        provider: 'cpu',
      });

      punctuationEngineRef.current = engine;
      setTextState((prev) => ({
        ...prev,
        initializedPunctuationModelId: prev.selectedPunctuationModelId,
        initializedPunctuationInstanceId: engine.instanceId,
      }));
      setPunctuationStatus(
        `Ready: ${getModelDisplayName(
          textState.selectedPunctuationModelId
        )} (instance ${engine.instanceId})`
      );
    } catch (err) {
      setTextState((prev) => ({
        ...prev,
        initializedPunctuationModelId: null,
        initializedPunctuationInstanceId: null,
      }));
      setError(`Punctuation init failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setInitializingPunctuation(false);
    }
  }, [resolvePunctuationModelPath, textState.selectedPunctuationModelId]);

  const handleInitializeVadModel = useCallback(async () => {
    if (!audioState.selectedVadModelId) {
      setError('Select a VAD model first.');
      return;
    }

    setInitializingVadModel(true);
    setError(null);
    setVadStatus(null);

    try {
      const vadConfig = getVadModelPathConfig(audioState.selectedVadModelId, {
        padModelIds: padVadModelIds,
        padModelsPath,
        bundledFolders: bundledVadFolders,
        downloadedIds: new Set(downloadedVadIds),
      });
      const fileSource = await toDetectSource(vadConfig);
      const detection = await detectVadModel(fileSource, {
        modelType: 'auto',
      });
      const modelPath = detection.paths?.model?.trim();
      const modelType = detection.modelType;

      if (!detection.success || !modelPath || !modelType) {
        throw new Error(
          detection.error || 'VAD model detection failed: no model path/type.'
        );
      }
      if (modelType !== 'silero_vad' && modelType !== 'ten_vad') {
        throw new Error(`Unsupported detected VAD model type: ${modelType}`);
      }

      setAudioState((prev) => ({
        ...prev,
        initializedVadModelId: prev.selectedVadModelId,
        initializedVadModelPath: modelPath,
        initializedVadFileSource: fileSource,
        detectedVadModelType: modelType,
      }));
      setVadStatus(
        `Using ${getModelDisplayName(
          audioState.selectedVadModelId
        )}\nModel file: ${modelPath}\nType: ${modelType}`
      );
    } catch (err) {
      setAudioState((prev) => ({
        ...prev,
        initializedVadModelId: null,
        initializedVadModelPath: null,
        initializedVadFileSource: null,
        detectedVadModelType: null,
      }));
      setError(`VAD model init failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setInitializingVadModel(false);
    }
  }, [
    audioState.selectedVadModelId,
    bundledVadFolders,
    downloadedVadIds,
    padModelsPath,
    padVadModelIds,
  ]);

  const handleRunTextSegmentation = useCallback(async () => {
    if (!textState.inputText.trim()) {
      setError('Please enter some text');
      return;
    }

    if (
      textState.evaluator === 'text_punctuation_assisted' &&
      (!textState.initializedPunctuationInstanceId ||
        textState.initializedPunctuationModelId !==
          textState.selectedPunctuationModelId)
    ) {
      setError(
        'Initialize a punctuation model first. This evaluator requires policy.punctuationInstanceId.'
      );
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
      }

      const textBuffer = await createOfflineTextBufferFromText(
        textState.inputText
      );
      textBufferRef.current = textBuffer.bufferId;

      const customDelims =
        textState.sentenceBoundary && textState.useCustomSentenceBoundaryChars
          ? parseSentenceBoundaryCharsInput(
              textState.sentenceBoundaryCharsInput
            )
          : [];
      const delimiterPolicy =
        customDelims.length > 0 ? { sentenceBoundaryChars: customDelims } : {};

      await segmentOfflineBuffer(
        textBuffer,
        textState.evaluator === 'text_synthetic_auto'
          ? {
              evaluator: 'text_synthetic_auto',
              sentenceBoundary: textState.sentenceBoundary,
              maxLengthChars: textState.maxLengthChars,
              ...delimiterPolicy,
            }
          : {
              evaluator: 'text_punctuation_assisted',
              punctuationInstanceId:
                textState.initializedPunctuationInstanceId ?? undefined,
              sentenceBoundary: textState.sentenceBoundary,
              maxLengthChars: textState.maxLengthChars,
              ...delimiterPolicy,
            }
      );

      const segments = (await getSegments(
        textBuffer,
        0,
        SEGMENT_PAGE_SIZE
      )) as TextSegment[];
      const totalSegmentCount = await getSegmentCount(textBuffer);
      setTextState((prev) => ({ ...prev, segments, totalSegmentCount }));
    } catch (err) {
      setError(`Text segmentation failed: ${normalizeErrorMessage(err)}`);
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
        textBufferRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  }, [
    textState.evaluator,
    textState.initializedPunctuationInstanceId,
    textState.initializedPunctuationModelId,
    textState.inputText,
    textState.maxLengthChars,
    textState.selectedPunctuationModelId,
    textState.sentenceBoundary,
    textState.sentenceBoundaryCharsInput,
    textState.useCustomSentenceBoundaryChars,
  ]);

  const handleRunAudioSegmentation = useCallback(async () => {
    if (!preparedAudioBuffer) {
      setError('Please select an audio file');
      return;
    }

    if (
      audioState.evaluator === 'speech_vad_model' &&
      (!audioState.selectedVadModelId ||
        !audioState.initializedVadFileSource ||
        audioState.initializedVadModelId !== audioState.selectedVadModelId)
    ) {
      setError(
        'Initialize a VAD model first. This evaluator requires policy.modelPath.'
      );
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const audioBufferId = preparedAudioBuffer.bufferId;
      audioBufferRef.current = audioBufferId;

      const energyDb = parseOptionalFloat(audioState.energyThresholdDb, -40);
      const vadTh = parseOptionalFloat(audioState.vadThreshold, 0.5);

      await segmentOfflineBuffer(
        audioBufferId,
        audioState.evaluator === 'speech_energy_silence'
          ? {
              evaluator: 'speech_energy_silence',
              silenceThresholdMs: audioState.silenceThresholdMs,
              energyThresholdDb: energyDb,
              minSegmentMs: audioState.minSegmentMs,
              maxSegmentMs: audioState.maxSegmentMs,
              hangoverMs: audioState.hangoverMs,
            }
          : {
              evaluator: 'speech_vad_model',
              modelPath: audioState.initializedVadFileSource!,
              vadThreshold: vadTh,
              vadMinSpeechMs: audioState.vadMinSpeechMs,
              vadMinSilenceMs: audioState.vadMinSilenceMs,
              minSegmentMs: audioState.minSegmentMs,
              maxSegmentMs: audioState.maxSegmentMs,
            }
      );

      const segments = (await getSegments(
        audioBufferId,
        0,
        SEGMENT_PAGE_SIZE
      )) as SpeechSegment[];
      const totalSegmentCount = await getSegmentCount(audioBufferId);
      setAudioState((prev) => ({ ...prev, segments, totalSegmentCount }));
    } catch (err) {
      setError(`Audio segmentation failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [
    preparedAudioBuffer,
    audioState.energyThresholdDb,
    audioState.evaluator,
    audioState.hangoverMs,
    audioState.initializedVadFileSource,
    audioState.initializedVadModelId,
    audioState.maxSegmentMs,
    audioState.minSegmentMs,
    audioState.selectedVadModelId,
    audioState.silenceThresholdMs,
    audioState.vadMinSilenceMs,
    audioState.vadMinSpeechMs,
    audioState.vadThreshold,
  ]);

  const handleLoadMoreTextSegments = useCallback(async () => {
    const bufferId = textBufferRef.current;
    if (!bufferId || loadingMoreSegments) return;
    const start = textState.segments.length;
    const total = textState.totalSegmentCount;
    if (total == null || start >= total) return;

    setLoadingMoreSegments(true);
    setError(null);
    try {
      const more = (await getSegments(
        bufferId,
        start,
        SEGMENT_PAGE_SIZE
      )) as TextSegment[];
      setTextState((prev) => ({
        ...prev,
        segments: [...prev.segments, ...more],
      }));
    } catch (err) {
      setError(`Load more segments failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoadingMoreSegments(false);
    }
  }, [
    loadingMoreSegments,
    textState.segments.length,
    textState.totalSegmentCount,
  ]);

  const handleLoadMoreAudioSegments = useCallback(async () => {
    const bufferId = audioBufferRef.current;
    if (!bufferId || loadingMoreSegments) return;
    const start = audioState.segments.length;
    const total = audioState.totalSegmentCount;
    if (total == null || start >= total) return;

    setLoadingMoreSegments(true);
    setError(null);
    try {
      const more = (await getSegments(
        bufferId,
        start,
        SEGMENT_PAGE_SIZE
      )) as SpeechSegment[];
      setAudioState((prev) => ({
        ...prev,
        segments: [...prev.segments, ...more],
      }));
    } catch (err) {
      setError(`Load more segments failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoadingMoreSegments(false);
    }
  }, [
    loadingMoreSegments,
    audioState.segments.length,
    audioState.totalSegmentCount,
  ]);

  const canRunTextSegmentation =
    !loading &&
    textState.inputText.trim().length > 0 &&
    (textState.evaluator === 'text_synthetic_auto' ||
      (!!textState.selectedPunctuationModelId &&
        !!textState.initializedPunctuationInstanceId &&
        textState.initializedPunctuationModelId ===
          textState.selectedPunctuationModelId));

  const canRunAudioSegmentation =
    !loading &&
    !!preparedAudioBuffer &&
    (audioState.evaluator === 'speech_energy_silence' ||
      (!!audioState.selectedVadModelId &&
        !!audioState.initializedVadFileSource &&
        audioState.initializedVadModelId === audioState.selectedVadModelId));

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
      >
        <View style={styles.modeSelector}>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'text' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('text');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'text' ? 'document-text' : 'document-text-outline'}
              size={20}
              color={mode === 'text' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'text' && styles.modeButtonTextActive,
              ]}
            >
              Text
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'audio' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('audio');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'audio' ? 'volume-high' : 'volume-high-outline'}
              size={20}
              color={mode === 'audio' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'audio' && styles.modeButtonTextActive,
              ]}
            >
              Audio
            </Text>
          </Pressable>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {mode === 'text' && (
          <View style={styles.modeContent}>
            <View>
              <Text style={styles.sectionTitle}>Text Input</Text>
              <Text style={styles.sectionDescription}>
                Offline text segmentation supports synthetic boundaries or a
                loaded punctuation instance.
              </Text>
              <TextInput
                style={styles.textInput}
                multiline
                placeholder="Enter text to segment..."
                placeholderTextColor="#999"
                value={textState.inputText}
                onChangeText={(inputText) =>
                  setTextState((prev) => ({ ...prev, inputText }))
                }
                editable={!loading}
              />
            </View>

            <View>
              <Text style={styles.sectionTitle}>Evaluator</Text>
              <View style={styles.optionList}>
                <Pressable
                  style={[
                    styles.optionCard,
                    textState.evaluator === 'text_synthetic_auto' &&
                      styles.optionCardActive,
                  ]}
                  onPress={() => {
                    setError(null);
                    setTextState((prev) => ({
                      ...prev,
                      evaluator: 'text_synthetic_auto',
                    }));
                  }}
                >
                  <Text
                    style={[
                      styles.optionTitle,
                      textState.evaluator === 'text_synthetic_auto' &&
                        styles.optionTitleActive,
                    ]}
                  >
                    text_synthetic_auto
                  </Text>
                  <Text style={styles.optionDescription}>
                    Segment by sentence hints and max text length.
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.optionCard,
                    textState.evaluator === 'text_punctuation_assisted' &&
                      styles.optionCardActive,
                  ]}
                  onPress={() => {
                    setError(null);
                    setTextState((prev) => ({
                      ...prev,
                      evaluator: 'text_punctuation_assisted',
                    }));
                  }}
                >
                  <Text
                    style={[
                      styles.optionTitle,
                      textState.evaluator === 'text_punctuation_assisted' &&
                        styles.optionTitleActive,
                    ]}
                  >
                    text_punctuation_assisted
                  </Text>
                  <Text style={styles.optionDescription}>
                    Use an initialized punctuation engine instance via
                    policy.punctuationInstanceId.
                  </Text>
                </Pressable>
              </View>
            </View>

            <View>
              <Text style={styles.sectionTitle}>Segmentation Policy</Text>
              <Text style={styles.sectionDescription}>
                Both text evaluators use sentence boundaries and max length
                after splitting rules apply (punctuation-assisted runs
                punctuation first).
              </Text>
              <View style={styles.policyControl}>
                <Text style={styles.policyLabel}>Max Length (chars):</Text>
                <TextInput
                  style={styles.policyInput}
                  keyboardType="number-pad"
                  value={String(textState.maxLengthChars)}
                  onChangeText={(text) => {
                    if (text.trim() === '') {
                      setTextState((prev) => ({ ...prev, maxLengthChars: 0 }));
                      return;
                    }
                    const num = parseInt(text, 10);
                    if (!Number.isNaN(num)) {
                      setTextState((prev) => ({
                        ...prev,
                        maxLengthChars: num,
                      }));
                    }
                  }}
                  editable={!loading}
                />
              </View>
              <View style={styles.policyControl}>
                <Text style={styles.policyLabel}>Sentence Boundary:</Text>
                <Switch
                  value={textState.sentenceBoundary}
                  onValueChange={(sentenceBoundary) =>
                    setTextState((prev) => ({ ...prev, sentenceBoundary }))
                  }
                  disabled={loading}
                />
              </View>
              {textState.sentenceBoundary && (
                <>
                  <View style={styles.policyControl}>
                    <Text style={styles.policyLabel}>
                      Custom boundary strings:
                    </Text>
                    <Switch
                      value={textState.useCustomSentenceBoundaryChars}
                      onValueChange={(useCustomSentenceBoundaryChars) =>
                        setTextState((prev) => ({
                          ...prev,
                          useCustomSentenceBoundaryChars,
                        }))
                      }
                      disabled={loading}
                    />
                  </View>
                  {textState.useCustomSentenceBoundaryChars && (
                    <>
                      <Text style={styles.sectionDescription}>
                        Pipe-separated delimiter strings. Type \n in the field
                        for a newline character.
                      </Text>
                      <TextInput
                        style={styles.textInput}
                        multiline
                        placeholder=". | ! | ? | \n"
                        placeholderTextColor="#999"
                        value={textState.sentenceBoundaryCharsInput}
                        onChangeText={(sentenceBoundaryCharsInput) =>
                          setTextState((prev) => ({
                            ...prev,
                            sentenceBoundaryCharsInput,
                          }))
                        }
                        editable={!loading}
                      />
                    </>
                  )}
                </>
              )}
            </View>

            {textState.evaluator === 'text_punctuation_assisted' && (
              <View>
                <Text style={styles.sectionTitle}>Punctuation Instance</Text>
                <Text style={styles.sectionDescription}>
                  Select a punctuation model and initialize it once for this
                  screen. The resulting instanceId is passed to offline
                  segmentation.
                </Text>

                {loadingPunctuationModels ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>
                      Loading punctuation models...
                    </Text>
                  </View>
                ) : availablePunctuationModels.length === 0 ? (
                  <View style={styles.warningContainer}>
                    <Text style={styles.warningText}>
                      No compatible punctuation models found. Add one under
                      assets/models, PAD, documents/models, or downloads
                      (category: punctuation).
                    </Text>
                  </View>
                ) : (
                  <View style={styles.modelButtons}>
                    {availablePunctuationModels.map((model) => {
                      const isSelected =
                        textState.selectedPunctuationModelId === model.id;
                      const isInitialized =
                        textState.initializedPunctuationModelId === model.id;

                      return (
                        <Pressable
                          key={model.id}
                          style={[
                            styles.modelSelectButton,
                            isSelected && styles.modelSelectButtonActive,
                            isInitialized &&
                              styles.modelSelectButtonInitialized,
                          ]}
                          onPress={() => {
                            setError(null);
                            setTextState((prev) => ({
                              ...prev,
                              selectedPunctuationModelId: model.id,
                            }));
                          }}
                          disabled={initializingPunctuation}
                        >
                          <Text
                            style={[
                              styles.modelSelectButtonTitle,
                              isSelected && styles.modelSelectButtonTitleActive,
                            ]}
                          >
                            {model.label}
                          </Text>
                          <Text style={styles.modelSelectButtonId}>
                            {model.id}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <Pressable
                  style={[
                    styles.button,
                    styles.secondaryButton,
                    (initializingPunctuation ||
                      !textState.selectedPunctuationModelId ||
                      availablePunctuationModels.length === 0) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={handleInitializePunctuation}
                  disabled={
                    initializingPunctuation ||
                    !textState.selectedPunctuationModelId ||
                    availablePunctuationModels.length === 0
                  }
                >
                  {initializingPunctuation ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <>
                      <Ionicons
                        name="sparkles"
                        size={18}
                        color="#FFF"
                        style={styles.buttonIcon}
                      />
                      <Text style={styles.buttonText}>
                        Use Punctuation Model
                      </Text>
                    </>
                  )}
                </Pressable>

                {punctuationStatus && (
                  <View style={styles.statusCard}>
                    <Text style={styles.statusTitle}>Loaded instance</Text>
                    <Text style={styles.statusText}>{punctuationStatus}</Text>
                  </View>
                )}
              </View>
            )}

            <Pressable
              style={[
                styles.button,
                (!canRunTextSegmentation || loading) && styles.buttonDisabled,
              ]}
              onPress={handleRunTextSegmentation}
              disabled={!canRunTextSegmentation}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Text</Text>
                </>
              )}
            </Pressable>

            {textState.segments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Segments ({textState.segments.length}
                  {textState.totalSegmentCount != null &&
                  textState.totalSegmentCount > textState.segments.length
                    ? ` of ${textState.totalSegmentCount}`
                    : ''}
                  )
                </Text>
                <FlatList
                  data={textState.segments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => {
                    const reasonColor = getColorForSegmentReason(item.reason);
                    return (
                      <View key={item.segmentId} style={styles.segmentCard}>
                        <View style={styles.segmentHeader}>
                          <Text style={styles.segmentIndex}>#{index + 1}</Text>
                          <View
                            style={[
                              styles.reasonBadge,
                              { backgroundColor: reasonColor },
                            ]}
                          >
                            <Text
                              style={[
                                styles.reasonBadgeText,
                                { color: SEGMENT_REASON_BADGE_LABEL_COLOR },
                              ]}
                            >
                              {item.reason}
                            </Text>
                          </View>
                          <Text style={styles.segmentMeta}>
                            {item.utf16Length} chars
                          </Text>
                        </View>
                        <Text style={styles.segmentText}>{item.text}</Text>
                      </View>
                    );
                  }}
                  keyExtractor={(item) => item.segmentId}
                />
                {textState.totalSegmentCount != null &&
                  textState.segments.length < textState.totalSegmentCount && (
                    <Pressable
                      style={[
                        styles.button,
                        styles.secondaryButton,
                        styles.showMoreSegmentsButton,
                        (loading || loadingMoreSegments) &&
                          styles.buttonDisabled,
                      ]}
                      onPress={handleLoadMoreTextSegments}
                      disabled={loading || loadingMoreSegments}
                    >
                      {loadingMoreSegments ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Text style={styles.buttonText}>
                          Show more (
                          {Math.min(
                            SEGMENT_PAGE_SIZE,
                            textState.totalSegmentCount -
                              textState.segments.length
                          )}{' '}
                          more)
                        </Text>
                      )}
                    </Pressable>
                  )}
              </>
            )}
          </View>
        )}

        {mode === 'audio' && (
          <View style={styles.modeContent}>
            <View>
              <Text style={styles.sectionTitle}>Audio File</Text>
              <Text style={styles.sectionDescription}>
                Offline audio segmentation can use energy-based silence
                detection or a VAD model.
              </Text>
              <OfflineAudioBufferWidget
                ref={audioWidgetRef}
                audioFiles={AUDIO_FILES}
                disabled={loading}
                onBufferReady={(info) => {
                  setPreparedAudioBuffer(info);
                  setAudioState((prev) => ({
                    ...prev,
                    segments: [],
                    totalSegmentCount: null,
                  }));
                }}
                onBufferReleased={() => {
                  setPreparedAudioBuffer(null);
                  audioBufferRef.current = null;
                  setAudioState((prev) => ({
                    ...prev,
                    segments: [],
                    totalSegmentCount: null,
                  }));
                }}
              />
            </View>

            <View>
              <Text style={styles.sectionTitle}>Evaluator</Text>
              <View style={styles.optionList}>
                <Pressable
                  style={[
                    styles.optionCard,
                    audioState.evaluator === 'speech_energy_silence' &&
                      styles.optionCardActive,
                  ]}
                  onPress={() => {
                    setError(null);
                    setAudioState((prev) => ({
                      ...prev,
                      evaluator: 'speech_energy_silence',
                    }));
                  }}
                >
                  <Text
                    style={[
                      styles.optionTitle,
                      audioState.evaluator === 'speech_energy_silence' &&
                        styles.optionTitleActive,
                    ]}
                  >
                    speech_energy_silence
                  </Text>
                  <Text style={styles.optionDescription}>
                    Segment from silence and energy thresholds.
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.optionCard,
                    audioState.evaluator === 'speech_vad_model' &&
                      styles.optionCardActive,
                  ]}
                  onPress={() => {
                    setError(null);
                    setAudioState((prev) => ({
                      ...prev,
                      evaluator: 'speech_vad_model',
                    }));
                  }}
                >
                  <Text
                    style={[
                      styles.optionTitle,
                      audioState.evaluator === 'speech_vad_model' &&
                        styles.optionTitleActive,
                    ]}
                  >
                    speech_vad_model
                  </Text>
                  <Text style={styles.optionDescription}>
                    Segment with a VAD bundle via policy.modelPath (FileSource;
                    same detect path as streaming VAD).
                  </Text>
                </Pressable>
              </View>
              <View style={styles.infoCard}>
                <Text style={styles.infoText}>
                  continuous_frames is not available here because this screen
                  only uses offline segmentOfflineBuffer. Use a live engine
                  screen for that evaluator.
                </Text>
              </View>
            </View>

            {audioState.evaluator === 'speech_energy_silence' ? (
              <View>
                <Text style={styles.sectionTitle}>Segmentation Policy</Text>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>
                    Silence Threshold (ms):
                  </Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.silenceThresholdMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          silenceThresholdMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          silenceThresholdMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>Energy Threshold (dB):</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="decimal-pad"
                    value={audioState.energyThresholdDb}
                    onChangeText={(text) =>
                      setAudioState((prev) => ({
                        ...prev,
                        energyThresholdDb: text,
                      }))
                    }
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>Min Segment (ms):</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.minSegmentMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          minSegmentMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          minSegmentMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>Max Segment (ms):</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.maxSegmentMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          maxSegmentMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          maxSegmentMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>Hangover (ms):</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.hangoverMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          hangoverMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          hangoverMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
              </View>
            ) : (
              <View>
                <Text style={styles.sectionTitle}>VAD Model</Text>
                <Text style={styles.sectionDescription}>
                  Choose an available VAD model, detect its concrete files once,
                  then use it for offline speech segmentation.
                </Text>

                {loadingVadModels ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>
                      Loading VAD models...
                    </Text>
                  </View>
                ) : availableVadModels.length === 0 ? (
                  <View style={styles.warningContainer}>
                    <Text style={styles.warningText}>
                      No VAD models found. Add one under assets/models, PAD,
                      documents/models, or downloads (category: vad).
                    </Text>
                  </View>
                ) : (
                  <View style={styles.modelButtons}>
                    {availableVadModels.map((model) => {
                      const isSelected =
                        audioState.selectedVadModelId === model.id;
                      const isInitialized =
                        audioState.initializedVadModelId === model.id;

                      return (
                        <Pressable
                          key={model.id}
                          style={[
                            styles.modelSelectButton,
                            isSelected && styles.modelSelectButtonActive,
                            isInitialized &&
                              styles.modelSelectButtonInitialized,
                          ]}
                          onPress={() => {
                            setError(null);
                            setAudioState((prev) => ({
                              ...prev,
                              selectedVadModelId: model.id,
                            }));
                          }}
                          disabled={initializingVadModel}
                        >
                          <View style={styles.modelHeaderRow}>
                            <Text
                              style={[
                                styles.modelSelectButtonTitle,
                                isSelected &&
                                  styles.modelSelectButtonTitleActive,
                              ]}
                            >
                              {model.label}
                            </Text>
                            {model.recommended && (
                              <View style={styles.recommendedBadge}>
                                <Text style={styles.recommendedBadgeText}>
                                  Recommended
                                </Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.modelSelectButtonId}>
                            {model.id}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <Pressable
                  style={[
                    styles.button,
                    styles.secondaryButton,
                    (initializingVadModel ||
                      !audioState.selectedVadModelId ||
                      availableVadModels.length === 0) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={handleInitializeVadModel}
                  disabled={
                    initializingVadModel ||
                    !audioState.selectedVadModelId ||
                    availableVadModels.length === 0
                  }
                >
                  {initializingVadModel ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <>
                      <Ionicons
                        name="hardware-chip"
                        size={18}
                        color="#FFF"
                        style={styles.buttonIcon}
                      />
                      <Text style={styles.buttonText}>Use VAD Model</Text>
                    </>
                  )}
                </Pressable>

                {vadStatus && (
                  <View style={styles.statusCard}>
                    <Text style={styles.statusTitle}>Loaded model</Text>
                    <Text style={styles.statusText}>{vadStatus}</Text>
                  </View>
                )}

                <Text style={styles.sectionTitle}>VAD segmentation policy</Text>
                <Text style={styles.sectionDescription}>
                  Threshold and min durations map to the VAD runtime; min/max
                  segment constrain emitted spans (max also caps max speech
                  duration in the VAD runtime).
                </Text>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>VAD score threshold:</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="decimal-pad"
                    value={audioState.vadThreshold}
                    onChangeText={(text) =>
                      setAudioState((prev) => ({
                        ...prev,
                        vadThreshold: text,
                      }))
                    }
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>
                    Min speech duration (ms):
                  </Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.vadMinSpeechMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          vadMinSpeechMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          vadMinSpeechMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>
                    Min silence duration (ms):
                  </Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.vadMinSilenceMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          vadMinSilenceMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          vadMinSilenceMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>Min segment (ms):</Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.minSegmentMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          minSegmentMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          minSegmentMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
                <View style={styles.policyControl}>
                  <Text style={styles.policyLabel}>
                    Max segment / max speech (ms):
                  </Text>
                  <TextInput
                    style={styles.policyInput}
                    keyboardType="number-pad"
                    value={String(audioState.maxSegmentMs)}
                    onChangeText={(text) => {
                      if (text.trim() === '') {
                        setAudioState((prev) => ({
                          ...prev,
                          maxSegmentMs: 0,
                        }));
                        return;
                      }
                      const num = parseInt(text, 10);
                      if (!Number.isNaN(num)) {
                        setAudioState((prev) => ({
                          ...prev,
                          maxSegmentMs: num,
                        }));
                      }
                    }}
                    editable={!loading}
                  />
                </View>
              </View>
            )}

            <Pressable
              style={[
                styles.button,
                (!canRunAudioSegmentation || loading) && styles.buttonDisabled,
              ]}
              onPress={handleRunAudioSegmentation}
              disabled={!canRunAudioSegmentation}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Audio</Text>
                </>
              )}
            </Pressable>

            {audioState.segments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Timeline ({audioState.segments.length}
                  {audioState.totalSegmentCount != null &&
                  audioState.totalSegmentCount > audioState.segments.length
                    ? ` of ${audioState.totalSegmentCount}`
                    : ''}{' '}
                  segments)
                </Text>
                <View style={styles.timelineContainer}>
                  <View style={styles.timeline}>
                    {audioState.segments.map((segment) => {
                      const totalDuration = audioState.segments.reduce(
                        (sum, current) => sum + current.durationMs,
                        0
                      );
                      const width =
                        totalDuration > 0
                          ? (segment.durationMs / totalDuration) * 100
                          : 0;
                      const color = getColorForSegmentReason(segment.reason);

                      return (
                        <View
                          key={segment.segmentId}
                          style={[
                            styles.timelineSegment,
                            { width: `${width}%`, backgroundColor: color },
                          ]}
                          accessibilityLabel={`${segment.reason}: ${segment.durationMs}ms`}
                        />
                      );
                    })}
                  </View>
                </View>

                <FlatList
                  data={audioState.segments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => {
                    const reasonColor = getColorForSegmentReason(item.reason);
                    return (
                      <View key={item.segmentId} style={styles.segmentCard}>
                        <View style={styles.segmentHeader}>
                          <Text style={styles.segmentIndex}>#{index + 1}</Text>
                          <View
                            style={[
                              styles.reasonBadge,
                              { backgroundColor: reasonColor },
                            ]}
                          >
                            <Text
                              style={[
                                styles.reasonBadgeText,
                                { color: SEGMENT_REASON_BADGE_LABEL_COLOR },
                              ]}
                            >
                              {item.reason}
                            </Text>
                          </View>
                          <Text style={styles.segmentMeta}>
                            {item.durationMs}ms
                          </Text>
                        </View>
                        {item.energy !== undefined && (
                          <Text style={styles.segmentDetail}>
                            Energy: {item.energy.toFixed(2)} dB
                          </Text>
                        )}
                        {item.vadInfo && (
                          <Text style={styles.segmentDetail}>
                            VAD: {item.vadInfo.decision || 'unknown'}
                          </Text>
                        )}
                      </View>
                    );
                  }}
                  keyExtractor={(item) => item.segmentId}
                />
                {audioState.totalSegmentCount != null &&
                  audioState.segments.length < audioState.totalSegmentCount && (
                    <Pressable
                      style={[
                        styles.button,
                        styles.secondaryButton,
                        styles.showMoreSegmentsButton,
                        (loading || loadingMoreSegments) &&
                          styles.buttonDisabled,
                      ]}
                      onPress={handleLoadMoreAudioSegments}
                      disabled={loading || loadingMoreSegments}
                    >
                      {loadingMoreSegments ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Text style={styles.buttonText}>
                          Show more (
                          {Math.min(
                            SEGMENT_PAGE_SIZE,
                            audioState.totalSegmentCount -
                              audioState.segments.length
                          )}{' '}
                          more)
                        </Text>
                      )}
                    </Pressable>
                  )}
              </>
            )}
          </View>
        )}
      </ScrollView>
      <ScreenIntroModal screenId="SegmentationShowcase" />
    </SafeAreaView>
  );
}
