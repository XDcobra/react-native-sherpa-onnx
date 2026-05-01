import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { DocumentDirectoryPath, unlink } from '@dr.pogodin/react-native-fs';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import { copyFile } from 'react-native-sherpa-onnx/fileio';
import {
  createAlignment,
  detectAlignmentModel,
  type AlignmentGranularity,
  type AlignmentModelType,
} from 'react-native-sherpa-onnx/alignment';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type SegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createStreamingVAD,
  detectVadModel,
  type VADEngine,
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
import { styles } from './GenerateTimestampScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

const PAD_PACK_NAME = 'sherpa_models';

/** Bundled wav2vec2 alignment folders are inferred as `unknown` by native listAssetModels (see STT/TTS hints). */
function isAlignmentModelFolder(folder: string, hint: string): boolean {
  if (hint === 'alignment') {
    return true;
  }
  const n = folder.toLowerCase();
  return n.includes('wav2vec');
}

function isVadModelFolder(folder: string, hint: string): boolean {
  if (hint === 'vad') {
    return true;
  }
  const n = folder.toLowerCase();
  return n.includes('vad') || n.includes('silero') || n.includes('ten-vad');
}

type AlignmentModelEntry = { id: string; label: string };
type VadModelEntry = { id: string; label: string };
type AlignmentSegmentView = Extract<SegmentMeta, { kind: 'alignment' }>;
type DerivedSubtitleItem = {
  text: string;
  startSec: number;
  endSec: number;
};
type AlignmentPipelineResult = {
  textInBufferId: string;
  audioInBufferId: string;
  segmentOutBufferId: string;
  segmentsWritten: number;
  writeDurationMs: number;
  warningCode?: string;
  vadAnchorCount?: number;
  minAnchorsApplied?: number;
  vadSegmentationBufferId?: string;
  alignmentSegments: AlignmentSegmentView[];
  errorCode?: string;
};

type DropdownType = 'mode' | 'granularity' | null;
type ScreenSubtitleMode =
  | 'proportional'
  | 'estimated'
  | 'accurate'
  | 'accurate_auto_asr'
  | 'accurate_auto_forced'
  | 'vad';

type ModeOption = {
  value: ScreenSubtitleMode;
  label: string;
  description: string;
};

type GranularityOption = {
  value: AlignmentGranularity;
  label: string;
  description: string;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'proportional',
    label: 'proportional',
    description: 'Spread duration by text weight (no alignment model)',
  },
  {
    value: 'estimated',
    label: 'estimated',
    description: 'Use caller-provided chunk timeline (no alignment model)',
  },
  {
    value: 'accurate',
    label: 'accurate',
    description: 'CTC forced alignment (wav2vec2; requires model)',
  },
  {
    value: 'accurate_auto_asr',
    label: 'accurate + auto (asrMediated / asr_mediated)',
    description:
      'Anchor-constrained accurate alignment via ASR-mediated linker (requires anchors + hypothesis buffer)',
  },
  {
    value: 'accurate_auto_forced',
    label: 'accurate + auto (chunkedForcedCtc / chunked_forced_ctc)',
    description: 'Anchor-constrained accurate alignment via forced CTC cursor',
  },
  {
    value: 'vad',
    label: 'vad',
    description: 'Use VAD speech segments from an offline segment buffer',
  },
];

const ALL_GRANULARITY_OPTIONS: GranularityOption[] = [
  {
    value: 'sentence',
    label: 'sentence',
    description: 'Generate one subtitle item per sentence',
  },
  {
    value: 'word',
    label: 'word',
    description: 'Generate one subtitle item per word',
  },
  {
    value: 'character',
    label: 'character',
    description:
      'Generate one subtitle item per character (accurate mode only)',
  },
];

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0';
  }
  return `${Math.round(ms)}`;
}

function extractErrorCode(message: string): string | null {
  const trimmed = message.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const maybeCode = trimmed.slice(0, idx).trim();
  return maybeCode.length > 0 ? maybeCode : null;
}

function normalizeUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURI(uri.replace(/^file:\/\//, ''));
  }
  return uri;
}

function getFileNameFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const segments = withoutQuery.split('/');
  return decodeURIComponent(segments[segments.length - 1] ?? 'audio.wav');
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function getAlignmentModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
  }
) {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Alignment, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
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
) {
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

export default function GenerateTimestampScreen() {
  const [availableModels, setAvailableModels] = useState<AlignmentModelEntry[]>(
    []
  );
  const [availableVadModels, setAvailableVadModels] = useState<VadModelEntry[]>(
    []
  );
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [padVadModelIds, setPadVadModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [bundledAlignmentFolders, setBundledAlignmentFolders] = useState<
    string[]
  >([]);
  const [bundledVadFolders, setBundledVadFolders] = useState<string[]>([]);
  const [downloadedAlignmentIds, setDownloadedAlignmentIds] = useState<
    string[]
  >([]);
  const [downloadedVadIds, setDownloadedVadIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedVadModelId, setSelectedVadModelId] = useState<string | null>(
    null
  );
  const [initializedModelId, setInitializedModelId] = useState<string | null>(
    null
  );
  const [initializedModelPath, setInitializedModelPath] = useState<
    string | null
  >(null);
  const [detectedModelType, setDetectedModelType] = useState<string | null>(
    null
  );
  const [initializingModel, setInitializingModel] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [initializedVadModelId, setInitializedVadModelId] = useState<
    string | null
  >(null);
  const [initializedVadModelPath, setInitializedVadModelPath] = useState<
    string | null
  >(null);
  const [detectedVadModelType, setDetectedVadModelType] =
    useState<VADModelType | null>(null);
  const [initializingVadModel, setInitializingVadModel] = useState(false);
  const [vadInitResult, setVadInitResult] = useState<string | null>(null);

  const [selectedAudioUri, setSelectedAudioUri] = useState<string | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState<string | null>(
    null
  );
  const [transcriptText, setTranscriptText] = useState<string>('');
  const [mode, setMode] = useState<ScreenSubtitleMode>('proportional');
  const [granularity, setGranularity] =
    useState<AlignmentGranularity>('sentence');
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'init' | 'generate' | null>(
    null
  );
  const [result, setResult] = useState<AlignmentPipelineResult | null>(null);
  const [segmentsResultExpanded, setSegmentsResultExpanded] = useState(true);
  const [subtitlesResultExpanded, setSubtitlesResultExpanded] = useState(true);

  const derivedSubtitles = useMemo<DerivedSubtitleItem[]>(() => {
    if (!result) {
      return [];
    }
    return result.alignmentSegments
      .map((segment) => {
        const sampleRate = segment.sampleRate > 0 ? segment.sampleRate : 1;
        return {
          text: String(segment.payload?.text ?? '').trim(),
          startSec: segment.startSample / sampleRate,
          endSec: segment.endSample / sampleRate,
        };
      })
      .filter((item) => item.text.length > 0 && item.endSec >= item.startSec);
  }, [result]);

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const assetModels = await listAssetModels();
      const bundledFolders = assetModels
        .filter((m) => isAlignmentModelFolder(m.folder, m.hint))
        .map((m) => m.folder);
      const bundledVadFolders = assetModels
        .filter((m) => isVadModelFolder(m.folder, m.hint))
        .map((m) => m.folder);

      let padFolders: string[] = [];
      let padVadFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => isAlignmentModelFolder(m.folder, m.hint))
          .map((m) => m.folder);
        padVadFolders = (padResults || [])
          .filter((m) => isVadModelFolder(m.folder, m.hint))
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
          console.log(
            'GenerateTimestampScreen: PAD/filesystem alignment models:',
            padFolders,
            'at',
            padPath
          );
        }
      } catch (e) {
        console.warn('GenerateTimestampScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);
      setPadVadModelIds(padVadFolders);
      setBundledAlignmentFolders(bundledFolders);
      setBundledVadFolders(bundledVadFolders);

      const downloaded = await listDownloadedModels(ModelCategory.Alignment);
      const downloadedIds = new Set(downloaded.map((d) => d.id));
      setDownloadedAlignmentIds([...downloadedIds]);
      const downloadedVad = await listDownloadedModels(ModelCategory.Vad);
      const downloadedVadIdsSet = new Set(downloadedVad.map((d) => d.id));
      setDownloadedVadIds([...downloadedVadIdsSet]);

      const combinedIds: string[] = [];
      const pushId = (id: string) => {
        if (!combinedIds.includes(id)) {
          combinedIds.push(id);
        }
      };
      for (const id of padFolders) {
        pushId(id);
      }
      for (const id of bundledFolders) {
        pushId(id);
      }
      for (const d of downloaded) {
        pushId(d.id);
      }

      const metaById = new Map(downloaded.map((m) => [m.id, m] as const));
      const entries: AlignmentModelEntry[] = combinedIds.map((id) => {
        const meta = metaById.get(id);
        return {
          id,
          label: meta ? getModelLabel(meta) : getModelDisplayName(id),
        };
      });

      setAvailableModels(entries);
      const combinedVadIds: string[] = [];
      const pushVadId = (id: string) => {
        if (!combinedVadIds.includes(id)) {
          combinedVadIds.push(id);
        }
      };
      for (const id of padVadFolders) {
        pushVadId(id);
      }
      for (const id of bundledVadFolders) {
        pushVadId(id);
      }
      for (const d of downloadedVad) {
        pushVadId(d.id);
      }
      const vadMetaById = new Map(downloadedVad.map((m) => [m.id, m] as const));
      const vadEntries: VadModelEntry[] = combinedVadIds.map((id) => {
        const meta = vadMetaById.get(id);
        return {
          id,
          label: meta ? getModelLabel(meta) : getModelDisplayName(id),
        };
      });
      setAvailableVadModels(vadEntries);

      const ids = new Set(combinedIds);
      setSelectedModelId((prev) => {
        if (prev && ids.has(prev)) {
          return prev;
        }
        return combinedIds[0] ?? null;
      });

      if (initializedModelId && !ids.has(initializedModelId)) {
        setInitializedModelId(null);
        setInitializedModelPath(null);
        setDetectedModelType(null);
        setInitResult(null);
      }
      const vadIds = new Set(combinedVadIds);
      setSelectedVadModelId((prev) => {
        if (prev && vadIds.has(prev)) {
          return prev;
        }
        return combinedVadIds[0] ?? null;
      });
      if (initializedVadModelId && !vadIds.has(initializedVadModelId)) {
        setInitializedVadModelId(null);
        setInitializedVadModelPath(null);
        setDetectedVadModelType(null);
        setVadInitResult(null);
      }
    } catch (err) {
      console.error(
        'GenerateTimestampScreen: Failed to load alignment models',
        err
      );
      setAvailableModels([]);
      setPadModelIds([]);
      setPadVadModelIds([]);
      setPadModelsPath(null);
      setBundledAlignmentFolders([]);
      setBundledVadFolders([]);
      setDownloadedAlignmentIds([]);
      setDownloadedVadIds([]);
      setSelectedModelId(null);
      setSelectedVadModelId(null);
      setAvailableVadModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [initializedModelId, initializedVadModelId]);

  useEffect(() => {
    loadAvailableModels().catch(() => {
      // ignore initial loading errors
    });
  }, [loadAvailableModels]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (
        category !== ModelCategory.Alignment &&
        category !== ModelCategory.Vad
      ) {
        return;
      }
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });

    return unsubscribe;
  }, [loadAvailableModels]);

  const selectedMode = useMemo(
    () =>
      MODE_OPTIONS.find((option) => option.value === mode) ?? {
        value: 'proportional',
        label: 'proportional',
        description: 'Proportional timing',
      },
    [mode]
  );

  const selectedGranularity = useMemo(
    () =>
      ALL_GRANULARITY_OPTIONS.find(
        (option) => option.value === granularity
      ) ?? {
        value: 'sentence',
        label: 'sentence',
        description: 'Generate one subtitle item per sentence',
      },
    [granularity]
  );

  const granularityOptions = useMemo(
    () =>
      mode === 'accurate'
        ? ALL_GRANULARITY_OPTIONS
        : ALL_GRANULARITY_OPTIONS.filter(
            (option) => option.value !== 'character'
          ),
    [mode]
  );

  const shouldWarnNonWav = useMemo(() => {
    if (!selectedAudioName) {
      return false;
    }
    return !selectedAudioName.toLowerCase().endsWith('.wav');
  }, [selectedAudioName]);

  useEffect(() => {
    const isValid = granularityOptions.some(
      (option) => option.value === granularity
    );
    if (!isValid) {
      setGranularity('sentence');
    }
  }, [granularity, granularityOptions]);

  const pickAudioFile = async () => {
    setError(null);
    setErrorSource(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as { fileUri?: string })?.fileUri ?? '';
      if (!uri) {
        setErrorSource('generate');
        setError('Could not resolve file URI from picker result.');
        return;
      }

      setSelectedAudioUri(uri);
      setSelectedAudioName(file?.name ?? getFileNameFromUri(uri));
      setResult(null);
    } catch (err: unknown) {
      const cancelled =
        (
          DocumentPicker as { isCancel?: (value: unknown) => boolean }
        ).isCancel?.(err) ?? false;
      if (cancelled) {
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Failed to pick audio file'
      );
      setErrorSource('generate');
    }
  };

  const handleInitializeModel = async () => {
    if (!selectedModelId) {
      setErrorSource('init');
      setError('Please select a subtitle model first.');
      return;
    }

    setError(null);
    setErrorSource(null);
    setInitializingModel(true);
    setInitResult(null);

    try {
      const detection = await detectAlignmentModel(
        await toDetectSource(
          getAlignmentModelPathConfig(selectedModelId, {
            padModelIds,
            padModelsPath,
            bundledFolders: bundledAlignmentFolders,
            downloadedIds: new Set(downloadedAlignmentIds),
          })
        ),
        { modelType: 'auto' as AlignmentModelType }
      );

      const modelPath = detection.paths?.model?.trim();
      if (!detection.success || !modelPath) {
        throw new Error(
          detection.error ||
            'Alignment model detection failed: no model.onnx path found.'
        );
      }

      setInitializedModelId(selectedModelId);
      setInitializedModelPath(modelPath);
      setDetectedModelType(
        detection.modelType ?? detection.detectedModels[0]?.type ?? null
      );
      setInitResult(
        `Initialized: ${getModelDisplayName(
          selectedModelId
        )}\nModel file: ${modelPath}`
      );
      setResult(null);
    } catch (err) {
      setErrorSource('init');
      setError(
        err instanceof Error ? err.message : 'Failed to initialize model'
      );
    } finally {
      setInitializingModel(false);
    }
  };

  const handleInitializeVadModel = async () => {
    if (!selectedVadModelId) {
      setErrorSource('init');
      setError('Please select a VAD model first.');
      return;
    }
    setError(null);
    setErrorSource(null);
    setInitializingVadModel(true);
    setVadInitResult(null);
    try {
      const vadConfig = getVadModelPathConfig(selectedVadModelId, {
        padModelIds: padVadModelIds,
        padModelsPath,
        bundledFolders: bundledVadFolders,
        downloadedIds: new Set(downloadedVadIds),
      });
      const detection = await detectVadModel(await toDetectSource(vadConfig), {
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
      setInitializedVadModelId(selectedVadModelId);
      setInitializedVadModelPath(modelPath);
      setDetectedVadModelType(modelType);
      setVadInitResult(
        `Initialized VAD: ${getModelDisplayName(
          selectedVadModelId
        )}\nModel file: ${modelPath}\nType: ${modelType}`
      );
      setResult(null);
    } catch (err) {
      setErrorSource('init');
      setError(
        err instanceof Error ? err.message : 'Failed to initialize VAD model'
      );
    } finally {
      setInitializingVadModel(false);
    }
  };

  const handleGenerateTimestamps = async () => {
    if (
      (mode === 'accurate' ||
        mode === 'accurate_auto_asr' ||
        mode === 'accurate_auto_forced') &&
      !initializedModelPath
    ) {
      setErrorSource('generate');
      setError('Please initialize a subtitle model first.');
      return;
    }
    if (
      (mode === 'vad' ||
        mode === 'accurate_auto_asr' ||
        mode === 'accurate_auto_forced') &&
      !initializedVadModelPath
    ) {
      setErrorSource('generate');
      setError('Please initialize a VAD model first.');
      return;
    }
    if (
      (mode === 'vad' ||
        mode === 'accurate_auto_asr' ||
        mode === 'accurate_auto_forced') &&
      !initializedVadModelId
    ) {
      setErrorSource('generate');
      setError(
        'Initialized VAD model metadata is missing; reinitialize VAD model.'
      );
      return;
    }
    if (!selectedAudioUri) {
      setErrorSource('generate');
      setError('Please choose an audio file first.');
      return;
    }

    const text = transcriptText.trim();
    if (!text) {
      setErrorSource('generate');
      setError('Please enter transcript text.');
      return;
    }

    setRunning(true);
    setError(null);
    setErrorSource(null);
    setResult(null);

    const alignment = createAlignment();
    let cleanupPath: string | null = null;
    let textBufferId: string | null = null;
    let audioBufferId: string | null = null;
    let segmentOutBufferId: string | null = null;
    let vadSegmentationBufferId: string | null = null;
    let vadEngine: VADEngine | null = null;
    try {
      let audioPath = normalizeUriToPath(selectedAudioUri);
      if (selectedAudioUri.startsWith('content://')) {
        const cacheName = `timestamp_input_${Date.now()}.wav`;
        const result = await copyFile(
          { kind: 'contentUri', uri: selectedAudioUri },
          { kind: 'app', base: 'cache', path: cacheName }
        );
        audioPath =
          result.output.kind === 'fs' ? result.output.path : audioPath;
        cleanupPath = audioPath;
      }

      const proportionalGranularity: 'sentence' | 'word' =
        granularity === 'character' ? 'sentence' : granularity;

      const textBuffer = await createOfflineTextBufferFromText(text);
      textBufferId = textBuffer.bufferId;

      const audioBuffer = await createOfflineAudioBufferFromFile({
        kind: 'fs',
        path: audioPath,
      });
      audioBufferId = audioBuffer.bufferId;

      const segmentOut = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: audioBuffer.bufferId,
      });
      segmentOutBufferId = segmentOut.bufferId;
      const writeStartedAt = Date.now();
      const writeResult =
        mode === 'accurate'
          ? await alignment.alignTextToAudio(
              textBuffer,
              audioBuffer,
              segmentOut,
              {
                mode: 'accurate',
                granularity,
                modelPath: { type: 'file', path: initializedModelPath! },
              }
            )
          : mode === 'estimated'
          ? await alignment.alignTextToAudio(
              textBuffer,
              audioBuffer,
              segmentOut,
              {
                mode: 'estimated',
                granularity: proportionalGranularity,
                chunks: {
                  sampleRate: 16000,
                  segmentSampleCounts: [3200, 4000, 2800],
                },
              }
            )
          : mode === 'vad' ||
            mode === 'accurate_auto_asr' ||
            mode === 'accurate_auto_forced'
          ? await (async () => {
              const vadConfig = getVadModelPathConfig(initializedVadModelId!, {
                padModelIds: padVadModelIds,
                padModelsPath,
                bundledFolders: bundledVadFolders,
                downloadedIds: new Set(downloadedVadIds),
              });
              vadEngine = await createStreamingVAD({
                modelPath: vadConfig,
                modelType: detectedVadModelType ?? 'auto',
                sampleRate: 16000,
              });
              const vadSegmentOut = await createEmptyOfflineSegmentBuffer({
                sourceAudioBufferId: audioBuffer.bufferId,
              });
              vadSegmentationBufferId = vadSegmentOut.bufferId;
              await vadEngine.process({
                audioIn: audioBuffer,
                segmentOut: vadSegmentOut,
                options: {
                  chunkSize: 512,
                  sourceTag: 'generate-timestamp-vad',
                },
              });
              if (mode === 'accurate_auto_asr') {
                const asrHypothesisOut = await createOfflineTextBufferFromText(
                  transcriptText
                );
                try {
                  return alignment.alignTextToAudio(
                    textBuffer,
                    audioBuffer,
                    segmentOut,
                    {
                      mode: 'accurate',
                      granularity: proportionalGranularity,
                      modelPath: { type: 'file', path: initializedModelPath! },
                      segmentation: {
                        mode: 'auto',
                        anchorSegmentBuffer: vadSegmentOut,
                        mappingStrategy: 'asr_mediated',
                        asr: {
                          hypothesisTextBuffer: asrHypothesisOut,
                        },
                      },
                    }
                  );
                } finally {
                  await releasePipelineTextBuffer(asrHypothesisOut).catch(
                    () => {
                      // ignore cleanup errors
                    }
                  );
                }
              }
              if (mode === 'accurate_auto_forced') {
                return alignment.alignTextToAudio(
                  textBuffer,
                  audioBuffer,
                  segmentOut,
                  {
                    mode: 'accurate',
                    granularity: proportionalGranularity,
                    modelPath: { type: 'file', path: initializedModelPath! },
                    segmentation: {
                      mode: 'auto',
                      anchorSegmentBuffer: vadSegmentOut,
                      mappingStrategy: 'chunked_forced_ctc',
                    },
                  }
                );
              }
              return alignment.alignTextToAudio(
                textBuffer,
                audioBuffer,
                segmentOut,
                {
                  mode: 'vad',
                  granularity: proportionalGranularity,
                  segmentation: {
                    source: 'vad',
                    segmentBuffer: vadSegmentOut,
                  },
                }
              );
            })()
          : await alignment.alignTextToAudio(
              textBuffer,
              audioBuffer,
              segmentOut,
              {
                mode: 'proportional',
                granularity: proportionalGranularity,
              }
            );
      const writeDurationMs = Date.now() - writeStartedAt;
      const segments = await getOfflineSegmentBufferSegments(
        segmentOut,
        0,
        4096
      );
      const alignmentSegments = segments.filter(
        (segment): segment is AlignmentSegmentView =>
          segment.kind === 'alignment'
      );
      setResult({
        textInBufferId: textBuffer.bufferId,
        audioInBufferId: audioBuffer.bufferId,
        segmentOutBufferId: writeResult.outputSegmentBufferId,
        segmentsWritten: writeResult.segmentsWritten,
        writeDurationMs,
        warningCode: writeResult.warningCode,
        vadAnchorCount: writeResult.vadAnchorCount,
        minAnchorsApplied: writeResult.minAnchorsApplied,
        vadSegmentationBufferId: vadSegmentationBufferId ?? undefined,
        alignmentSegments,
      });
      await releasePipelineSegmentBuffer(segmentOut.bufferId).catch(() => {
        // ignore cleanup errors
      });
      segmentOutBufferId = null;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate timestamps';
      setError(message);
      setErrorSource('generate');
      setResult((prev) =>
        prev
          ? { ...prev, errorCode: extractErrorCode(message) ?? undefined }
          : null
      );
    } finally {
      if (textBufferId) {
        await releasePipelineTextBuffer(textBufferId).catch(() => {
          // ignore cleanup errors
        });
      }
      if (audioBufferId) {
        await releasePipelineAudioBuffer(audioBufferId).catch(() => {
          // ignore cleanup errors
        });
      }
      if (cleanupPath) {
        unlink(cleanupPath).catch(() => {
          // ignore cleanup errors
        });
      }
      if (segmentOutBufferId) {
        await releasePipelineSegmentBuffer(segmentOutBufferId).catch(() => {
          // ignore cleanup errors
        });
      }
      if (vadSegmentationBufferId) {
        await releasePipelineSegmentBuffer(vadSegmentationBufferId).catch(
          () => {
            // ignore cleanup errors
          }
        );
      }
      await (vadEngine as VADEngine | null)?.destroy?.().catch(() => {
        // ignore cleanup errors
      });
      await alignment.destroy().catch(() => {
        // ignore cleanup errors
      });
      setRunning(false);
    }
  };

  const closeDropdown = () => setOpenDropdown(null);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize Model</Text>
            <Text style={styles.sectionDescription}>
              Select an alignment model from bundled assets (assets/models/),
              Play Asset Delivery, app documents, or downloads, then validate
              with autodetect before generation.
            </Text>

            {(selectedModelId || initializedModelId) && (
              <View style={styles.currentModelContainer}>
                <Text style={styles.currentModelText}>
                  {initializedModelId
                    ? `Initialized: ${getModelDisplayName(initializedModelId)}`
                    : `Selected: ${
                        selectedModelId
                          ? getModelDisplayName(selectedModelId)
                          : ''
                      }`}
                </Text>
                {detectedModelType && initializedModelId && (
                  <Text style={styles.currentModelMetaText}>
                    Detected type: {detectedModelType}
                  </Text>
                )}
              </View>
            )}

            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>
                  Loading alignment models...
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningBannerText}>
                  No alignment models found. Add a wav2vec2 model under
                  assets/models/, use PAD or documents/models, or download one
                  (category: alignment).
                </Text>
              </View>
            ) : (
              <View style={styles.modelButtons}>
                {availableModels.map((model) => {
                  const isSelected = selectedModelId === model.id;
                  const isInitialized = initializedModelId === model.id;
                  return (
                    <TouchableOpacity
                      key={model.id}
                      style={[
                        styles.modelSelectButton,
                        isSelected && styles.modelSelectButtonActive,
                        isInitialized && styles.modelSelectButtonInitialized,
                        initializingModel && styles.buttonDisabled,
                      ]}
                      onPress={() => setSelectedModelId(model.id)}
                      disabled={initializingModel}
                    >
                      <Text
                        style={[
                          styles.modelSelectButtonTitle,
                          isSelected && styles.modelSelectButtonTitleActive,
                        ]}
                      >
                        {model.label}
                      </Text>
                      <Text style={styles.modelSelectButtonId}>{model.id}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                styles.applyButton,
                initializingModel && styles.buttonDisabled,
              ]}
              onPress={handleInitializeModel}
              disabled={
                initializingModel ||
                !selectedModelId ||
                availableModels.length === 0
              }
            >
              {initializingModel ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Use model</Text>
              )}
            </TouchableOpacity>

            {initResult && !(error && errorSource === 'init') && (
              <View style={styles.initResultCard}>
                <Text style={styles.initResultText}>{initResult}</Text>
              </View>
            )}

            {error && errorSource === 'init' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Select Audio File</Text>
            <Text style={styles.sectionDescription}>
              Choose the audio file for timestamp generation.
            </Text>

            <View style={styles.hintCard}>
              <Ionicons
                name="information-circle-outline"
                size={18}
                color="#FF9800"
              />
              <Text style={styles.hintText}>
                Recommended input format: WAV, mono, 16 kHz.
              </Text>
            </View>

            <TouchableOpacity style={styles.button} onPress={pickAudioFile}>
              <Text style={styles.buttonText}>Choose Audio File</Text>
            </TouchableOpacity>

            {selectedAudioName && (
              <View style={styles.selectedFileCard}>
                <Text style={styles.selectedFileLabel}>Selected:</Text>
                <Text style={styles.selectedFileName}>{selectedAudioName}</Text>
                {shouldWarnNonWav && (
                  <Text style={styles.warningText}>
                    This file is not a .wav file. For best results use WAV mono
                    16 kHz.
                  </Text>
                )}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Transcript Text</Text>
            <Text style={styles.sectionDescription}>
              Enter the text that should be aligned to the selected audio.
            </Text>
            <Text style={styles.inputLabel}>Transcript</Text>
            <TextInput
              style={styles.textInput}
              value={transcriptText}
              onChangeText={setTranscriptText}
              placeholder="Enter transcript text..."
              multiline
              numberOfLines={5}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>4. Options</Text>
            <Text style={styles.sectionDescription}>
              Set subtitle mode and granularity (character is accurate-only). In
              VAD mode, this screen auto-creates/releases a temporary
              segmentation buffer per run.
            </Text>

            <View style={styles.modelSummaryCard}>
              <Text style={styles.modelSummaryLabel}>Initialized model</Text>
              <Text style={styles.modelSummaryValue}>
                {initializedModelId
                  ? getModelDisplayName(initializedModelId)
                  : 'Not initialized'}
              </Text>
              {initializedModelPath && (
                <Text style={styles.modelSummaryPath}>
                  {initializedModelPath}
                </Text>
              )}
            </View>

            <View style={styles.optionRow}>
              <Text style={styles.inputLabel}>Mode</Text>
              <TouchableOpacity
                style={styles.dropdownTrigger}
                onPress={() => setOpenDropdown('mode')}
              >
                <Text style={styles.dropdownTriggerText}>
                  {selectedMode.label}
                </Text>
                <Ionicons name="chevron-down" size={16} color="#666" />
              </TouchableOpacity>
            </View>

            <View style={styles.optionRow}>
              <Text style={styles.inputLabel}>Granularity</Text>
              <TouchableOpacity
                style={styles.dropdownTrigger}
                onPress={() => setOpenDropdown('granularity')}
              >
                <Text style={styles.dropdownTriggerText}>
                  {selectedGranularity.label}
                </Text>
                <Ionicons name="chevron-down" size={16} color="#666" />
              </TouchableOpacity>
            </View>

            {(mode === 'vad' ||
              mode === 'accurate_auto_asr' ||
              mode === 'accurate_auto_forced') && (
              <View style={styles.vadConfigContainer}>
                <Text style={styles.inputLabel}>
                  VAD model for segmentation
                </Text>
                {loadingModels ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>
                      Loading VAD models...
                    </Text>
                  </View>
                ) : availableVadModels.length === 0 ? (
                  <View style={styles.warningContainer}>
                    <Text style={styles.warningBannerText}>
                      No VAD models found. Add one under assets/models, PAD,
                      documents/models, or downloads (category: vad).
                    </Text>
                  </View>
                ) : (
                  <View style={styles.modelButtons}>
                    {availableVadModels.map((model) => {
                      const isSelected = selectedVadModelId === model.id;
                      const isInitialized = initializedVadModelId === model.id;
                      return (
                        <TouchableOpacity
                          key={model.id}
                          style={[
                            styles.modelSelectButton,
                            isSelected && styles.modelSelectButtonActive,
                            isInitialized &&
                              styles.modelSelectButtonInitialized,
                            initializingVadModel && styles.buttonDisabled,
                          ]}
                          onPress={() => setSelectedVadModelId(model.id)}
                          disabled={initializingVadModel}
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
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.applyButton,
                    initializingVadModel && styles.buttonDisabled,
                  ]}
                  onPress={handleInitializeVadModel}
                  disabled={
                    initializingVadModel ||
                    !selectedVadModelId ||
                    availableVadModels.length === 0
                  }
                >
                  {initializingVadModel ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.buttonText}>Use VAD model</Text>
                  )}
                </TouchableOpacity>
                {vadInitResult && (
                  <View style={styles.initResultCard}>
                    <Text style={styles.initResultText}>{vadInitResult}</Text>
                  </View>
                )}
                {(mode === 'accurate_auto_asr' ||
                  mode === 'accurate_auto_forced') && (
                  <Text style={styles.sectionDescription}>
                    Auto-accurate modes require speech anchors. asrMediated also
                    requires a timestamped ASR hypothesis buffer.
                  </Text>
                )}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                styles.generateButton,
                running && styles.buttonDisabled,
              ]}
              onPress={handleGenerateTimestamps}
              disabled={running}
            >
              {running ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Generate Timestamps</Text>
              )}
            </TouchableOpacity>

            {error && errorSource === 'generate' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>5. Result</Text>
            {result ? (
              <>
                <View style={styles.resultCard}>
                  <Text style={styles.resultMetaText}>Pipeline I/O</Text>
                  <Text style={styles.resultCodeText}>
                    textInBufferId: {result.textInBufferId}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    audioInBufferId: {result.audioInBufferId}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    segmentOutBufferId: {result.segmentOutBufferId}
                  </Text>
                  {result.vadSegmentationBufferId && (
                    <Text style={styles.resultCodeText}>
                      vadSegmentationBufferId: {result.vadSegmentationBufferId}
                    </Text>
                  )}
                </View>

                <View style={styles.resultCard}>
                  <Text style={styles.resultMetaText}>Write Result</Text>
                  <Text style={styles.resultMetaText}>
                    segmentsWritten: {result.segmentsWritten}
                  </Text>
                  <Text style={styles.resultMetaText}>
                    writeDurationMs: {formatMs(result.writeDurationMs)}
                  </Text>
                  <Text style={styles.resultMetaText}>
                    errorCode: {result.errorCode ?? 'none'}
                  </Text>
                  <Text style={styles.resultMetaText}>
                    warningCode: {result.warningCode ?? 'none'}
                  </Text>
                  <Text style={styles.resultMetaText}>
                    vadAnchorCount: {String(result.vadAnchorCount ?? 'n/a')}
                  </Text>
                  <Text style={styles.resultMetaText}>
                    minAnchorsApplied:{' '}
                    {String(result.minAnchorsApplied ?? 'n/a')}
                  </Text>
                </View>

                <View style={styles.resultCard}>
                  <TouchableOpacity
                    style={styles.resultAccordionHeader}
                    onPress={() => setSegmentsResultExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      SegmentBuffer Segments ({result.alignmentSegments.length})
                    </Text>
                    <Ionicons
                      name={
                        segmentsResultExpanded ? 'chevron-up' : 'chevron-down'
                      }
                      size={16}
                      color="#666"
                    />
                  </TouchableOpacity>
                  {segmentsResultExpanded &&
                    (result.alignmentSegments.length > 0 ? (
                      <View style={styles.subtitleList}>
                        {result.alignmentSegments.map((segment, index) => (
                          <View
                            key={`${segment.id}-${index}`}
                            style={styles.subtitleItem}
                          >
                            <Text style={styles.subtitleText}>
                              #{index} {segment.startSample}-{segment.endSample}{' '}
                              ({segment.durationMs}ms)
                            </Text>
                            <Text style={styles.subtitleTime}>
                              {segment.payload?.text ?? '...'}
                            </Text>
                            <Text style={styles.subtitleTime}>
                              mode={segment.payload?.timingMode ?? 'n/a'}{' '}
                              granularity=
                              {segment.payload?.granularity ?? 'n/a'}
                            </Text>
                            {segment.payload?.tokenMetadata && (
                              <Text style={styles.subtitleTime}>
                                mapping=
                                {String(
                                  segment.payload.tokenMetadata
                                    .mappingStrategy ?? 'n/a'
                                )}{' '}
                                units=
                                {String(
                                  segment.payload.tokenMetadata.textUnitCount ??
                                    'n/a'
                                )}{' '}
                                anchors=
                                {String(
                                  segment.payload.tokenMetadata
                                    .vadAnchorCount ?? 'n/a'
                                )}{' '}
                                minAnchors=
                                {String(
                                  segment.payload.tokenMetadata
                                    .minAnchorsApplied ?? 'n/a'
                                )}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        Output buffer is empty (no alignment segments written).
                      </Text>
                    ))}
                </View>

                <View style={styles.resultCard}>
                  <TouchableOpacity
                    style={styles.resultAccordionHeader}
                    onPress={() => setSubtitlesResultExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      Derived Subtitles ({derivedSubtitles.length})
                    </Text>
                    <Ionicons
                      name={
                        subtitlesResultExpanded ? 'chevron-up' : 'chevron-down'
                      }
                      size={16}
                      color="#666"
                    />
                  </TouchableOpacity>
                  {subtitlesResultExpanded &&
                    (derivedSubtitles.length > 0 ? (
                      <View style={styles.subtitleList}>
                        {derivedSubtitles.map((subtitle, index) => (
                          <View
                            key={`subtitle-${index}-${subtitle.startSec}`}
                            style={styles.subtitleItem}
                          >
                            <Text style={styles.subtitleText}>
                              #{index + 1} [{subtitle.startSec.toFixed(2)}s -{' '}
                              {subtitle.endSec.toFixed(2)}s]
                            </Text>
                            <Text style={styles.subtitleTime}>
                              {subtitle.text}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        No derived subtitles available.
                      </Text>
                    ))}
                </View>
              </>
            ) : (
              <Text style={styles.emptyText}>
                No pipeline output yet. Initialize a model and run generation.
              </Text>
            )}
          </View>
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="GenerateTimestamp" />

      <Modal
        transparent
        visible={openDropdown != null}
        animationType="fade"
        onRequestClose={closeDropdown}
      >
        <Pressable style={styles.dropdownBackdrop} onPress={closeDropdown}>
          <Pressable style={styles.dropdownMenu}>
            <Text style={styles.dropdownTitle}>
              {openDropdown === 'mode' ? 'Select mode' : 'Select granularity'}
            </Text>
            {openDropdown === 'mode'
              ? MODE_OPTIONS.map((option) => {
                  const active = option.value === mode;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.dropdownItem,
                        active && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setMode(option.value);
                        closeDropdown();
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          active && styles.dropdownItemTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text style={styles.dropdownItemDescription}>
                        {option.description}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              : granularityOptions.map((option) => {
                  const active = option.value === granularity;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.dropdownItem,
                        active && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setGranularity(option.value);
                        closeDropdown();
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          active && styles.dropdownItemTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text style={styles.dropdownItemDescription}>
                        {option.description}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
