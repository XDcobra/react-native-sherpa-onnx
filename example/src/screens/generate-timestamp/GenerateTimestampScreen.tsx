import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
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
} from 'react-native-sherpa-onnx/utils';
import { copyFile } from 'react-native-sherpa-onnx/fileio';
import {
  createAlignment,
  detectAlignmentModel,
  type AlignmentGranularity,
  type AlignmentModelType,
  type AlignmentWarning,
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
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { segmentOfflineBuffer } from 'react-native-sherpa-onnx/segment';
import {
  createSTT,
  detectSttModel,
  type STTModelType,
} from 'react-native-sherpa-onnx/stt';
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
import type { ModelPathConfig } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { RECOMMENDED_MODEL_IDS } from '../../utils/recommendedModels';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { styles } from './GenerateTimestampScreen.styles';

type UiMode =
  | 'proportional'
  | 'estimated'
  | 'accurate'
  | 'vad'
  | 'asr_mediated'
  | 'chunked_forced_ctc';

type ModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

type ModelCatalog = {
  entries: ModelEntry[];
  bundledIds: string[];
  padIds: string[];
  downloadedIds: string[];
  padPath: string | null;
};

type AlignmentSegmentView = Extract<SegmentMeta, { kind: 'alignment' }>;

type DerivedSubtitleItem = {
  text: string;
  startSec: number;
  endSec: number;
};

type RunResult = {
  mode: UiMode;
  textInBufferId: string;
  audioInBufferId: string;
  outputSegmentBufferId: string;
  anchorSegmentBufferId?: string;
  hypothesisTextBufferId?: string;
  segmentsWritten: number;
  writeDurationMs: number;
  warningCode?: string;
  warnings?: AlignmentWarning[];
  alignmentSegments: AlignmentSegmentView[];
};

type ModeConfig = {
  value: UiMode;
  title: string;
  description: string;
  apiMode: 'proportional' | 'estimated' | 'accurate' | 'vad';
  allowedGranularities: AlignmentGranularity[];
  granularityHint: string;
  requiresAlignmentModel: boolean;
  requiresVadModel: boolean;
  requiresSttModel: boolean;
  requiresEstimatedChunks: boolean;
  runButtonLabel: string;
};

const PAD_PACK_NAME = 'sherpa_models';
const DEFAULT_REFERENCE_TEXT =
  'This is the reference transcript that should be aligned to the selected audio.';
const DEFAULT_ESTIMATED_SAMPLE_RATE = '16000';
const DEFAULT_ESTIMATED_COUNTS = '3200, 4000, 2800';
const EMPTY_MODEL_CATALOG: ModelCatalog = {
  entries: [],
  bundledIds: [],
  padIds: [],
  downloadedIds: [],
  padPath: null,
};
const MODE_CONFIGS: ModeConfig[] = [
  {
    value: 'proportional',
    title: 'proportional',
    description:
      'Splits the reference text by granularity and distributes timing by text weight over the full audio duration. No models and no anchors.',
    apiMode: 'proportional',
    allowedGranularities: ['sentence', 'word'],
    granularityHint: 'Only sentence and word are valid for proportional mode.',
    requiresAlignmentModel: false,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run proportional alignment',
  },
  {
    value: 'estimated',
    title: 'estimated',
    description:
      'Uses caller-provided chunk sample counts plus sampleRate to assign estimated timestamps. No acoustic alignment model is involved.',
    apiMode: 'estimated',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Estimated mode only supports sentence and word granularity, plus explicit chunk sample counts.',
    requiresAlignmentModel: false,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: true,
    runButtonLabel: 'Run estimated alignment',
  },
  {
    value: 'accurate',
    title: 'accurate',
    description:
      'Runs plain wav2vec2 CTC forced alignment over the full offline waveform and reference transcript.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word', 'character'],
    granularityHint:
      'Character granularity is only valid in plain accurate mode without segmentation auto.',
    requiresAlignmentModel: true,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment',
  },
  {
    value: 'vad',
    title: 'vad',
    description:
      'Creates offline speech anchors with speech_vad_model and maps text units monotonically onto those anchors. No wav2vec2 model is used.',
    apiMode: 'vad',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'VAD mode only supports sentence and word. Character is rejected by the native API.',
    requiresAlignmentModel: false,
    requiresVadModel: true,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run VAD alignment',
  },
  {
    value: 'asr_mediated',
    title: 'accurate + asr_mediated',
    description:
      'Anchor-constrained accurate alignment with speech anchors plus a timestamped ASR hypothesis buffer H. Missing token timestamps fail with ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS and do not fall back.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Anchor-based accurate modes support sentence and word only. Character is disabled.',
    requiresAlignmentModel: true,
    requiresVadModel: true,
    requiresSttModel: true,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment (asr_mediated)',
  },
  {
    value: 'chunked_forced_ctc',
    title: 'accurate + chunked_forced_ctc',
    description:
      'Anchor-constrained accurate alignment with deterministic chunked forced CTC cursor progression. Uses speech anchors, but no ASR hypothesis buffer.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Anchor-based accurate modes support sentence and word only. Character is disabled.',
    requiresAlignmentModel: true,
    requiresVadModel: true,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment (chunked_forced_ctc)',
  },
];
const ALL_GRANULARITIES: AlignmentGranularity[] = [
  'sentence',
  'word',
  'character',
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

function isAlignmentModelFolder(folder: string, hint: string): boolean {
  if (hint === 'alignment') {
    return true;
  }
  return folder.toLowerCase().includes('wav2vec');
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

function isSttModelFolder(_: string, hint: string): boolean {
  return hint === 'stt';
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

function buildModelCatalog(params: {
  category: ModelCategory;
  assetModels: Array<{ folder: string; hint: string }>;
  padModels: Array<{ folder: string; hint: string }>;
  downloadedModels: ModelMeta[];
  filter: (folder: string, hint: string) => boolean;
  recommendedIds?: string[];
  padPath: string | null;
}): ModelCatalog {
  const {
    assetModels,
    padModels,
    downloadedModels,
    filter,
    recommendedIds,
    padPath,
  } = params;
  const bundledIds = assetModels
    .filter((model) => filter(model.folder, model.hint))
    .map((model) => model.folder);
  const padIds = padModels
    .filter((model) => filter(model.folder, model.hint))
    .map((model) => model.folder);
  const downloadedIds = downloadedModels.map((model) => model.id);
  const metaById = new Map(
    downloadedModels.map((model) => [model.id, model] as const)
  );
  const mergedIds: string[] = [];
  const pushId = (id: string) => {
    if (!mergedIds.includes(id)) {
      mergedIds.push(id);
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

  return {
    entries: prioritizeEntries(
      mergedIds.map((id) => {
        const meta = metaById.get(id);
        return {
          id,
          label: meta ? getModelLabel(meta) : getModelDisplayName(id),
        };
      }),
      recommendedIds
    ),
    bundledIds,
    padIds,
    downloadedIds,
    padPath,
  };
}

function resolveModelPathForCatalog(
  modelId: string,
  category: ModelCategory,
  catalog: ModelCatalog
): ModelPathConfig {
  if (catalog.padIds.includes(modelId)) {
    return catalog.padPath
      ? getFileModelPath(modelId, category, catalog.padPath)
      : getFileModelPath(modelId, category);
  }
  if (catalog.downloadedIds.includes(modelId)) {
    return getFileModelPath(modelId, category);
  }
  if (catalog.bundledIds.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

function parseEstimatedTimeline(
  sampleRateText: string,
  countsText: string
): { sampleRate: number; segmentSampleCounts: number[] } {
  const sampleRate = parseInt(sampleRateText.trim(), 10);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Estimated mode requires a positive sample rate.');
  }

  const segmentSampleCounts = countsText
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInt(value, 10));

  if (segmentSampleCounts.length === 0) {
    throw new Error(
      'Estimated mode requires at least one segmentSampleCounts value.'
    );
  }
  if (
    segmentSampleCounts.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error('Estimated segmentSampleCounts must be positive integers.');
  }

  return { sampleRate, segmentSampleCounts };
}

function getGranularityDisabledReason(
  mode: UiMode,
  granularity: AlignmentGranularity
): string | null {
  const config = MODE_CONFIGS.find((item) => item.value === mode)!;
  if (config.allowedGranularities.includes(granularity)) {
    return null;
  }
  if (granularity === 'character') {
    if (mode === 'vad') {
      return 'Character is rejected for vad mode.';
    }
    if (mode === 'estimated' || mode === 'proportional') {
      return 'Character is only supported by plain accurate mode.';
    }
    return 'Character is disabled when segmentation auto is active.';
  }
  return config.granularityHint;
}

function SectionCard(props: {
  stepLabel: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>{props.stepLabel}</Text>
        </View>
        <Text style={styles.sectionTitle}>{props.title}</Text>
        {props.description ? (
          <Text style={styles.sectionDescription}>{props.description}</Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function ModelPreparationCard(props: {
  stepLabel: string;
  title: string;
  description: string;
  loading: boolean;
  emptyMessage: string;
  models: ModelEntry[];
  selectedId: string | null;
  preparedId: string | null;
  preparing: boolean;
  prepareLabel: string;
  preparedSummary: string | null;
  onSelect: (id: string) => void;
  onPrepare: () => void;
}) {
  return (
    <SectionCard
      stepLabel={props.stepLabel}
      title={props.title}
      description={props.description}
    >
      {props.preparedId ? (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            Ready: {getModelDisplayName(props.preparedId)}
          </Text>
          {props.preparedSummary ? (
            <Text style={styles.currentModelMetaText}>
              {props.preparedSummary}
            </Text>
          ) : null}
        </View>
      ) : null}

      {props.loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.loadingText}>Loading available models...</Text>
        </View>
      ) : props.models.length === 0 ? (
        <View style={styles.warningContainer}>
          <Text style={styles.warningBannerText}>{props.emptyMessage}</Text>
        </View>
      ) : (
        <View style={styles.modelButtons}>
          {props.models.map((model) => {
            const isSelected = props.selectedId === model.id;
            const isPrepared = props.preparedId === model.id;
            return (
              <Pressable
                key={model.id}
                style={[
                  styles.modelSelectButton,
                  isSelected && styles.modelSelectButtonActive,
                  isPrepared && styles.modelSelectButtonInitialized,
                ]}
                onPress={() => props.onSelect(model.id)}
                disabled={props.preparing}
              >
                <View style={styles.modelHeaderRow}>
                  <Text
                    style={[
                      styles.modelSelectButtonTitle,
                      isSelected && styles.modelSelectButtonTitleActive,
                    ]}
                  >
                    {model.label}
                  </Text>
                  {model.recommended ? (
                    <View style={styles.recommendedBadge}>
                      <Text style={styles.recommendedBadgeText}>
                        Recommended
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.modelSelectButtonId}>{model.id}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <Pressable
        style={[
          styles.button,
          styles.applyButton,
          (props.preparing || !props.selectedId || props.models.length === 0) &&
            styles.buttonDisabled,
        ]}
        onPress={props.onPrepare}
        disabled={
          props.preparing || !props.selectedId || props.models.length === 0
        }
      >
        {props.preparing ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>{props.prepareLabel}</Text>
        )}
      </Pressable>
    </SectionCard>
  );
}

export default function GenerateTimestampScreen() {
  const [mode, setMode] = useState<UiMode>('proportional');
  const [granularity, setGranularity] =
    useState<AlignmentGranularity>('sentence');
  const [selectedAudioUri, setSelectedAudioUri] = useState<string | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState<string | null>(
    null
  );
  const [referenceTranscript, setReferenceTranscript] = useState(
    DEFAULT_REFERENCE_TEXT
  );
  const [estimatedSampleRateText, setEstimatedSampleRateText] = useState(
    DEFAULT_ESTIMATED_SAMPLE_RATE
  );
  const [estimatedSegmentCountsText, setEstimatedSegmentCountsText] = useState(
    DEFAULT_ESTIMATED_COUNTS
  );
  const [loadingModelCatalogs, setLoadingModelCatalogs] = useState(false);
  const [alignmentCatalog, setAlignmentCatalog] =
    useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [vadCatalog, setVadCatalog] =
    useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const [sttCatalog, setSttCatalog] =
    useState<ModelCatalog>(EMPTY_MODEL_CATALOG);

  const [selectedAlignmentModelId, setSelectedAlignmentModelId] = useState<
    string | null
  >(null);
  const [preparedAlignmentModelId, setPreparedAlignmentModelId] = useState<
    string | null
  >(null);
  const [preparedAlignmentModelPath, setPreparedAlignmentModelPath] = useState<
    string | null
  >(null);
  const [preparedAlignmentModelType, setPreparedAlignmentModelType] = useState<
    AlignmentModelType | string | null
  >(null);
  const [preparingAlignmentModel, setPreparingAlignmentModel] = useState(false);
  const [alignmentPrepareSummary, setAlignmentPrepareSummary] = useState<
    string | null
  >(null);

  const [selectedVadModelId, setSelectedVadModelId] = useState<string | null>(
    null
  );
  const [preparedVadModelId, setPreparedVadModelId] = useState<string | null>(
    null
  );
  const [preparedVadModelPath, setPreparedVadModelPath] = useState<
    string | null
  >(null);
  const [preparedVadModelType, setPreparedVadModelType] =
    useState<VADModelType | null>(null);
  const [preparingVadModel, setPreparingVadModel] = useState(false);
  const [vadPrepareSummary, setVadPrepareSummary] = useState<string | null>(
    null
  );

  const [selectedSttModelId, setSelectedSttModelId] = useState<string | null>(
    null
  );
  const [preparedSttModelId, setPreparedSttModelId] = useState<string | null>(
    null
  );
  const [preparedSttModelType, setPreparedSttModelType] = useState<
    STTModelType | string | null
  >(null);
  const [preparingSttModel, setPreparingSttModel] = useState(false);
  const [sttPrepareSummary, setSttPrepareSummary] = useState<string | null>(
    null
  );

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [segmentsExpanded, setSegmentsExpanded] = useState(true);
  const [subtitlesExpanded, setSubtitlesExpanded] = useState(true);

  const activeMode = useMemo<ModeConfig>(
    () => MODE_CONFIGS.find((item) => item.value === mode)!,
    [mode]
  );

  const stepLabels = useMemo(() => {
    let nextStep = 1;
    return {
      mode: `Step ${nextStep++}`,
      inputs: `Step ${nextStep++}`,
      granularity: `Step ${nextStep++}`,
      estimated: activeMode.requiresEstimatedChunks
        ? `Step ${nextStep++}`
        : null,
      alignment: activeMode.requiresAlignmentModel
        ? `Step ${nextStep++}`
        : null,
      vad: activeMode.requiresVadModel ? `Step ${nextStep++}` : null,
      stt: activeMode.requiresSttModel ? `Step ${nextStep++}` : null,
      run: `Step ${nextStep++}`,
      result: `Step ${nextStep++}`,
    };
  }, [activeMode]);

  const derivedSubtitles = useMemo<DerivedSubtitleItem[]>(() => {
    if (!result) {
      return [];
    }
    return result.alignmentSegments
      .map((segment) => ({
        text: String(segment.payload?.text ?? '').trim(),
        startSec: segment.startSample / Math.max(1, segment.sampleRate),
        endSec: segment.endSample / Math.max(1, segment.sampleRate),
      }))
      .filter((item) => item.text.length > 0 && item.endSec >= item.startSec);
  }, [result]);

  const estimatedTimeline = useMemo(() => {
    if (mode !== 'estimated') {
      return {
        sampleRate: null,
        counts: [] as number[],
        error: null as string | null,
      };
    }
    try {
      const parsed = parseEstimatedTimeline(
        estimatedSampleRateText,
        estimatedSegmentCountsText
      );
      return {
        sampleRate: parsed.sampleRate,
        counts: parsed.segmentSampleCounts,
        error: null,
      };
    } catch (err) {
      return {
        sampleRate: null,
        counts: [] as number[],
        error:
          err instanceof Error ? err.message : 'Invalid estimated timeline.',
      };
    }
  }, [estimatedSampleRateText, estimatedSegmentCountsText, mode]);

  const shouldWarnNonWav = useMemo(() => {
    if (!selectedAudioName) {
      return false;
    }
    return !selectedAudioName.toLowerCase().endsWith('.wav');
  }, [selectedAudioName]);

  const loadModelCatalogs = useCallback(async () => {
    setLoadingModelCatalogs(true);
    try {
      const [assetModels, downloadedAlignment, downloadedVad, downloadedStt] =
        await Promise.all([
          listAssetModels(),
          listDownloadedModels(ModelCategory.Alignment),
          listDownloadedModels(ModelCategory.Vad),
          listDownloadedModels(ModelCategory.Stt),
        ]);

      let padModels: Array<{ folder: string; hint: string }> = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        padModels = await listModelsAtPath(padPath);
        if (padModels.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch {
        padModels = [];
      }

      const nextAlignmentCatalog = buildModelCatalog({
        category: ModelCategory.Alignment,
        assetModels,
        padModels,
        downloadedModels: downloadedAlignment,
        filter: isAlignmentModelFolder,
        padPath: resolvedPadPath,
      });
      const nextVadCatalog = buildModelCatalog({
        category: ModelCategory.Vad,
        assetModels,
        padModels,
        downloadedModels: downloadedVad,
        filter: isVadModelFolder,
        recommendedIds: RECOMMENDED_MODEL_IDS[ModelCategory.Vad],
        padPath: resolvedPadPath,
      });
      const nextSttCatalog = buildModelCatalog({
        category: ModelCategory.Stt,
        assetModels,
        padModels,
        downloadedModels: downloadedStt,
        filter: isSttModelFolder,
        recommendedIds: RECOMMENDED_MODEL_IDS[ModelCategory.Stt],
        padPath: resolvedPadPath,
      });

      setAlignmentCatalog(nextAlignmentCatalog);
      setVadCatalog(nextVadCatalog);
      setSttCatalog(nextSttCatalog);

      const alignmentIds = new Set(
        nextAlignmentCatalog.entries.map((entry) => entry.id)
      );
      const vadIds = new Set(nextVadCatalog.entries.map((entry) => entry.id));
      const sttIds = new Set(nextSttCatalog.entries.map((entry) => entry.id));

      setSelectedAlignmentModelId((prev) =>
        prev && alignmentIds.has(prev)
          ? prev
          : nextAlignmentCatalog.entries[0]?.id ?? null
      );
      setSelectedVadModelId((prev) =>
        prev && vadIds.has(prev) ? prev : nextVadCatalog.entries[0]?.id ?? null
      );
      setSelectedSttModelId((prev) =>
        prev && sttIds.has(prev) ? prev : nextSttCatalog.entries[0]?.id ?? null
      );

      if (
        preparedAlignmentModelId &&
        !alignmentIds.has(preparedAlignmentModelId)
      ) {
        setPreparedAlignmentModelId(null);
        setPreparedAlignmentModelPath(null);
        setPreparedAlignmentModelType(null);
        setAlignmentPrepareSummary(null);
      }
      if (preparedVadModelId && !vadIds.has(preparedVadModelId)) {
        setPreparedVadModelId(null);
        setPreparedVadModelPath(null);
        setPreparedVadModelType(null);
        setVadPrepareSummary(null);
      }
      if (preparedSttModelId && !sttIds.has(preparedSttModelId)) {
        setPreparedSttModelId(null);
        setPreparedSttModelType(null);
        setSttPrepareSummary(null);
      }
    } catch (err) {
      console.error(
        'GenerateTimestampScreen: failed to load model catalogs',
        err
      );
      setAlignmentCatalog(EMPTY_MODEL_CATALOG);
      setVadCatalog(EMPTY_MODEL_CATALOG);
      setSttCatalog(EMPTY_MODEL_CATALOG);
      setSelectedAlignmentModelId(null);
      setSelectedVadModelId(null);
      setSelectedSttModelId(null);
    } finally {
      setLoadingModelCatalogs(false);
    }
  }, [preparedAlignmentModelId, preparedSttModelId, preparedVadModelId]);

  useEffect(() => {
    loadModelCatalogs().catch(() => {});
  }, [loadModelCatalogs]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (
        category !== ModelCategory.Alignment &&
        category !== ModelCategory.Vad &&
        category !== ModelCategory.Stt
      ) {
        return;
      }
      loadModelCatalogs().catch(() => {});
    });

    return unsubscribe;
  }, [loadModelCatalogs]);

  useEffect(() => {
    if (!activeMode.allowedGranularities.includes(granularity)) {
      setGranularity(activeMode.allowedGranularities[0] ?? 'sentence');
    }
  }, [activeMode, granularity]);

  const runBlockingIssues = useMemo(() => {
    const issues: string[] = [];
    if (!selectedAudioUri) {
      issues.push('Select an audio file.');
    }
    if (!referenceTranscript.trim()) {
      issues.push('Enter a reference transcript.');
    }
    if (!activeMode.allowedGranularities.includes(granularity)) {
      issues.push(activeMode.granularityHint);
    }
    if (activeMode.requiresEstimatedChunks && estimatedTimeline.error) {
      issues.push(estimatedTimeline.error);
    }
    if (
      activeMode.requiresAlignmentModel &&
      (!selectedAlignmentModelId ||
        preparedAlignmentModelId !== selectedAlignmentModelId)
    ) {
      issues.push('Prepare the selected alignment model with Use model.');
    }
    if (
      activeMode.requiresVadModel &&
      (!selectedVadModelId || preparedVadModelId !== selectedVadModelId)
    ) {
      issues.push('Prepare the selected VAD model with Use model.');
    }
    if (
      activeMode.requiresSttModel &&
      (!selectedSttModelId || preparedSttModelId !== selectedSttModelId)
    ) {
      issues.push('Prepare the selected STT model with Use model.');
    }
    return issues;
  }, [
    activeMode,
    estimatedTimeline.error,
    granularity,
    preparedAlignmentModelId,
    preparedSttModelId,
    preparedVadModelId,
    referenceTranscript,
    selectedAlignmentModelId,
    selectedAudioUri,
    selectedSttModelId,
    selectedVadModelId,
  ]);

  const pickAudioFile = useCallback(async () => {
    setError(null);
    setErrorCode(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as { fileUri?: string })?.fileUri ?? '';
      if (!uri) {
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
        err instanceof Error ? err.message : 'Failed to pick audio file.'
      );
    }
  }, []);

  const handlePrepareAlignmentModel = useCallback(async () => {
    if (!selectedAlignmentModelId) {
      setError('Select an alignment model first.');
      return;
    }

    setPreparingAlignmentModel(true);
    setError(null);
    setErrorCode(null);
    setAlignmentPrepareSummary(null);

    try {
      const detection = await detectAlignmentModel(
        await toDetectSource(
          resolveModelPathForCatalog(
            selectedAlignmentModelId,
            ModelCategory.Alignment,
            alignmentCatalog
          )
        ),
        { modelType: 'auto' as AlignmentModelType }
      );
      const modelPath = detection.paths?.model?.trim();
      if (!detection.success || !modelPath) {
        throw new Error(
          detection.error ||
            'Alignment model detection failed: no model path found.'
        );
      }

      setPreparedAlignmentModelId(selectedAlignmentModelId);
      setPreparedAlignmentModelPath(modelPath);
      setPreparedAlignmentModelType(
        detection.modelType ?? detection.detectedModels[0]?.type ?? null
      );
      setAlignmentPrepareSummary(
        `${getModelDisplayName(selectedAlignmentModelId)}\nmodel: ${modelPath}`
      );
      setResult(null);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to prepare alignment model.';
      setError(message);
      setErrorCode(extractErrorCode(message));
    } finally {
      setPreparingAlignmentModel(false);
    }
  }, [alignmentCatalog, selectedAlignmentModelId]);

  const handlePrepareVadModel = useCallback(async () => {
    if (!selectedVadModelId) {
      setError('Select a VAD model first.');
      return;
    }

    setPreparingVadModel(true);
    setError(null);
    setErrorCode(null);
    setVadPrepareSummary(null);

    try {
      const detection = await detectVadModel(
        await toDetectSource(
          resolveModelPathForCatalog(
            selectedVadModelId,
            ModelCategory.Vad,
            vadCatalog
          )
        ),
        { modelType: 'auto' }
      );
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

      setPreparedVadModelId(selectedVadModelId);
      setPreparedVadModelPath(modelPath);
      setPreparedVadModelType(modelType);
      setVadPrepareSummary(
        `${getModelDisplayName(
          selectedVadModelId
        )}\nmodel: ${modelPath}\ntype: ${modelType}`
      );
      setResult(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to prepare VAD model.';
      setError(message);
      setErrorCode(extractErrorCode(message));
    } finally {
      setPreparingVadModel(false);
    }
  }, [selectedVadModelId, vadCatalog]);

  const handlePrepareSttModel = useCallback(async () => {
    if (!selectedSttModelId) {
      setError('Select an STT model first.');
      return;
    }

    setPreparingSttModel(true);
    setError(null);
    setErrorCode(null);
    setSttPrepareSummary(null);

    try {
      const detection = await detectSttModel(
        await toDetectSource(
          resolveModelPathForCatalog(
            selectedSttModelId,
            ModelCategory.Stt,
            sttCatalog
          )
        ),
        { modelType: 'auto' }
      );
      if (!detection.success || detection.detectedModels.length === 0) {
        throw new Error(
          detection.error ||
            'STT model detection failed: no compatible models found.'
        );
      }
      const detectedType =
        detection.modelType ?? detection.detectedModels[0]?.type ?? null;
      setPreparedSttModelId(selectedSttModelId);
      setPreparedSttModelType(detectedType);
      setSttPrepareSummary(
        `${getModelDisplayName(selectedSttModelId)}\ndetected: ${
          detectedType ?? 'unknown'
        }\nstreaming: ${detection.isStreaming ? 'yes' : 'no'}`
      );
      setResult(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to prepare STT model.';
      setError(message);
      setErrorCode(extractErrorCode(message));
    } finally {
      setPreparingSttModel(false);
    }
  }, [selectedSttModelId, sttCatalog]);

  const handleRunAlignment = useCallback(async () => {
    if (runBlockingIssues.length > 0) {
      setError(
        runBlockingIssues[0] ??
          'Resolve the remaining pipeline requirements first.'
      );
      setErrorCode(null);
      return;
    }

    setRunning(true);
    setError(null);
    setErrorCode(null);
    setResult(null);

    const alignment = createAlignment();
    let stt: Awaited<ReturnType<typeof createSTT>> | null = null;
    let cleanupPath: string | null = null;
    let textBufferId: string | null = null;
    let audioBufferId: string | null = null;
    let outputSegmentBufferId: string | null = null;
    let anchorSegmentBufferId: string | null = null;
    let hypothesisTextBufferId: string | null = null;

    try {
      let audioPath = normalizeUriToPath(selectedAudioUri!);
      if (selectedAudioUri!.startsWith('content://')) {
        const safeName = (selectedAudioName ?? 'alignment-input.wav').replace(
          /[^a-zA-Z0-9._-]/g,
          '_'
        );
        const cacheName = `generate_timestamp_${Date.now()}_${safeName}`;
        const copied = await copyFile(
          { kind: 'contentUri', uri: selectedAudioUri! },
          { kind: 'app', base: 'cache', path: cacheName }
        );
        audioPath =
          copied.output.kind === 'fs' ? copied.output.path : audioPath;
        cleanupPath = audioPath;
      }

      const referenceBuffer = await createOfflineTextBufferFromText(
        referenceTranscript.trim()
      );
      textBufferId = referenceBuffer.bufferId;

      const audioBuffer = await createOfflineAudioBufferFromFile({
        kind: 'fs',
        path: audioPath,
      });
      audioBufferId = audioBuffer.bufferId;

      const outputBuffer = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: audioBuffer.bufferId,
      });
      outputSegmentBufferId = outputBuffer.bufferId;

      const alignmentModelPath = activeMode.requiresAlignmentModel
        ? resolveModelPathForCatalog(
            preparedAlignmentModelId!,
            ModelCategory.Alignment,
            alignmentCatalog
          )
        : null;
      const vadModelPath = activeMode.requiresVadModel
        ? resolveModelPathForCatalog(
            preparedVadModelId!,
            ModelCategory.Vad,
            vadCatalog
          )
        : null;
      const sttModelPath = activeMode.requiresSttModel
        ? resolveModelPathForCatalog(
            preparedSttModelId!,
            ModelCategory.Stt,
            sttCatalog
          )
        : null;

      let anchorRef: Awaited<ReturnType<typeof segmentOfflineBuffer>> | null =
        null;
      if (activeMode.requiresVadModel) {
        anchorRef = await segmentOfflineBuffer(audioBuffer, {
          evaluator: 'speech_vad_model',
          modelPath: vadModelPath!,
        });
        anchorSegmentBufferId = anchorRef.segmentBufferId;
      }

      if (activeMode.requiresSttModel) {
        const hypothesisBuffer = await createEmptyOfflineTextBuffer();
        hypothesisTextBufferId = hypothesisBuffer.bufferId;
        stt = await createSTT({
          modelPath: sttModelPath!,
          modelType: 'auto',
          numThreads: 2,
        });
        await stt.transcribe(audioBuffer, hypothesisBuffer, {
          segmentation: { mode: 'off' },
        });
      }

      const writeStartedAt = Date.now();
      const textGranularity = granularity as 'sentence' | 'word';
      const writeResult =
        mode === 'proportional'
          ? await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'proportional',
                granularity: textGranularity,
              }
            )
          : mode === 'estimated'
          ? await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'estimated',
                granularity: textGranularity,
                chunks: {
                  sampleRate: estimatedTimeline.sampleRate!,
                  segmentSampleCounts: estimatedTimeline.counts,
                },
              }
            )
          : mode === 'accurate'
          ? await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'accurate',
                granularity,
                modelPath: alignmentModelPath!,
              }
            )
          : mode === 'vad'
          ? await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'vad',
                granularity: textGranularity,
                segmentation: {
                  source: 'vad',
                  segmentBuffer: anchorSegmentBufferId!,
                },
              }
            )
          : mode === 'asr_mediated'
          ? await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'accurate',
                granularity: textGranularity,
                modelPath: alignmentModelPath!,
                segmentation: {
                  mode: 'auto',
                  anchorSegmentBuffer: anchorSegmentBufferId!,
                  mappingStrategy: 'asr_mediated',
                  asr: {
                    hypothesisTextBuffer: hypothesisTextBufferId!,
                  },
                },
              }
            )
          : await alignment.alignTextToAudio(
              referenceBuffer,
              audioBuffer,
              outputBuffer,
              {
                mode: 'accurate',
                granularity: textGranularity,
                modelPath: alignmentModelPath!,
                segmentation: {
                  mode: 'auto',
                  anchorSegmentBuffer: anchorSegmentBufferId!,
                  mappingStrategy: 'chunked_forced_ctc',
                },
              }
            );
      const writeDurationMs = Date.now() - writeStartedAt;
      const segments = await getOfflineSegmentBufferSegments(
        outputBuffer,
        0,
        4096
      );
      const alignmentSegments = segments.filter(
        (segment): segment is AlignmentSegmentView =>
          segment.kind === 'alignment'
      );

      setResult({
        mode,
        textInBufferId: referenceBuffer.bufferId,
        audioInBufferId: audioBuffer.bufferId,
        outputSegmentBufferId: writeResult.outputSegmentBufferId,
        anchorSegmentBufferId: anchorSegmentBufferId ?? undefined,
        hypothesisTextBufferId: hypothesisTextBufferId ?? undefined,
        segmentsWritten: writeResult.segmentsWritten,
        writeDurationMs,
        warningCode: writeResult.warningCode,
        warnings: writeResult.warnings,
        alignmentSegments,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to run offline alignment pipeline.';
      setError(message);
      setErrorCode(extractErrorCode(message));
    } finally {
      await stt?.destroy().catch(() => {});
      if (hypothesisTextBufferId) {
        await releasePipelineTextBuffer(hypothesisTextBufferId).catch(() => {});
      }
      if (anchorSegmentBufferId) {
        await releasePipelineSegmentBuffer(anchorSegmentBufferId).catch(
          () => {}
        );
      }
      if (outputSegmentBufferId) {
        await releasePipelineSegmentBuffer(outputSegmentBufferId).catch(
          () => {}
        );
      }
      if (textBufferId) {
        await releasePipelineTextBuffer(textBufferId).catch(() => {});
      }
      if (audioBufferId) {
        await releasePipelineAudioBuffer(audioBufferId).catch(() => {});
      }
      if (cleanupPath) {
        await unlink(cleanupPath).catch(() => {});
      }
      await alignment.destroy().catch(() => {});
      setRunning(false);
    }
  }, [
    activeMode,
    alignmentCatalog,
    estimatedTimeline.counts,
    estimatedTimeline.sampleRate,
    granularity,
    mode,
    preparedAlignmentModelId,
    preparedSttModelId,
    preparedVadModelId,
    referenceTranscript,
    runBlockingIssues,
    selectedAudioName,
    selectedAudioUri,
    sttCatalog,
    vadCatalog,
  ]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <SectionCard
            stepLabel={stepLabels.mode}
            title="Choose offline alignment mode"
            description="Each mode below maps 1:1 to a documented public alignment path. There are no silent fallbacks between modes."
          >
            <View style={styles.modeGrid}>
              {MODE_CONFIGS.map((item) => {
                const isSelected = item.value === mode;
                return (
                  <Pressable
                    key={item.value}
                    style={[
                      styles.modeCard,
                      isSelected && styles.modeCardActive,
                    ]}
                    onPress={() => {
                      setMode(item.value);
                      setError(null);
                      setErrorCode(null);
                      setResult(null);
                    }}
                  >
                    <Text
                      style={[
                        styles.modeCardTitle,
                        isSelected && styles.modeCardTitleActive,
                      ]}
                    >
                      {item.title}
                    </Text>
                    <Text style={styles.modeCardDescription}>
                      {item.description}
                    </Text>
                    <View style={styles.modeMetaRow}>
                      {item.allowedGranularities.map((value) => (
                        <View
                          key={`${item.value}-${value}`}
                          style={styles.metaPill}
                        >
                          <Text style={styles.metaPillText}>{value}</Text>
                        </View>
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          <SectionCard
            stepLabel={stepLabels.inputs}
            title="Provide shared inputs"
            description="All public alignment modes consume the same offline audio base plus a reference transcript R. In asr_mediated, this reference remains separate from the ASR hypothesis buffer H."
          >
            <Text style={styles.inputLabel}>Audio file</Text>
            <View style={styles.hintCard}>
              <Ionicons
                name="information-circle-outline"
                size={18}
                color="#FF9800"
              />
              <Text style={styles.hintText}>
                Recommended input format: WAV, mono, 16 kHz. The same offline
                audio buffer is reused for anchors, STT, and final alignment.
              </Text>
            </View>
            <Pressable style={styles.button} onPress={pickAudioFile}>
              <Text style={styles.buttonText}>Choose audio file</Text>
            </Pressable>
            {selectedAudioName ? (
              <View style={styles.selectedFileCard}>
                <Text style={styles.selectedFileLabel}>Selected file</Text>
                <Text style={styles.selectedFileName}>{selectedAudioName}</Text>
                {selectedAudioUri ? (
                  <Text style={styles.selectedFileMeta}>
                    {selectedAudioUri}
                  </Text>
                ) : null}
                {shouldWarnNonWav ? (
                  <Text style={styles.warningText}>
                    This is not a .wav file. The pipeline still uses
                    createOfflineAudioBufferFromFile, but WAV mono 16 kHz
                    matches the documented happy path best.
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text style={styles.inputLabel}>Reference transcript (R)</Text>
            <TextInput
              style={styles.textInput}
              value={referenceTranscript}
              onChangeText={setReferenceTranscript}
              placeholder="Enter the reference transcript that should align to audio"
              multiline
            />
            <Text style={styles.inlineHelpText}>
              This buffer is always the reference text. It is never reused as
              the ASR hypothesis in asr_mediated.
            </Text>
          </SectionCard>

          <SectionCard
            stepLabel={stepLabels.granularity}
            title="Choose valid granularity"
            description={activeMode.granularityHint}
          >
            <View style={styles.choiceList}>
              {ALL_GRANULARITIES.map((value) => {
                const disabledReason = getGranularityDisabledReason(
                  mode,
                  value
                );
                const isSelected = granularity === value;
                const disabled = disabledReason != null;
                return (
                  <Pressable
                    key={value}
                    style={[
                      styles.choiceCard,
                      isSelected && styles.choiceCardActive,
                      disabled && styles.choiceCardDisabled,
                    ]}
                    onPress={() => {
                      if (disabled) {
                        return;
                      }
                      setGranularity(value);
                    }}
                    disabled={disabled}
                  >
                    <Text
                      style={[
                        styles.choiceTitle,
                        isSelected && styles.choiceTitleActive,
                        disabled && styles.choiceTitleDisabled,
                      ]}
                    >
                      {value}
                    </Text>
                    <Text style={styles.choiceDescription}>
                      {value === 'sentence'
                        ? 'Generate one aligned unit per sentence.'
                        : value === 'word'
                        ? 'Generate one aligned unit per word.'
                        : 'Generate one aligned unit per character.'}
                    </Text>
                    {disabledReason ? (
                      <Text style={styles.choiceReason}>{disabledReason}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          {activeMode.requiresEstimatedChunks ? (
            <SectionCard
              stepLabel={stepLabels.estimated!}
              title="Provide estimated chunk timeline"
              description="Estimated mode consumes caller-provided segmentSampleCounts and sampleRate exactly as documented. No alignment ONNX is loaded for this path."
            >
              <Text style={styles.inputLabel}>Sample rate</Text>
              <TextInput
                style={styles.inlineInput}
                value={estimatedSampleRateText}
                onChangeText={setEstimatedSampleRateText}
                keyboardType="number-pad"
                placeholder="16000"
              />
              <Text style={styles.inputLabel}>segmentSampleCounts</Text>
              <TextInput
                style={styles.textInput}
                value={estimatedSegmentCountsText}
                onChangeText={setEstimatedSegmentCountsText}
                placeholder="3200, 4000, 2800"
                multiline
              />
              <Text style={styles.inlineHelpText}>
                Enter positive integers separated by commas, spaces, or new
                lines.
              </Text>
              {estimatedTimeline.error ? (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningBannerText}>
                    {estimatedTimeline.error}
                  </Text>
                </View>
              ) : (
                <View style={styles.currentModelContainer}>
                  <Text style={styles.currentModelText}>
                    Parsed {estimatedTimeline.counts.length} chunk values at{' '}
                    {estimatedTimeline.sampleRate} Hz
                  </Text>
                </View>
              )}
            </SectionCard>
          ) : null}

          {activeMode.requiresAlignmentModel ? (
            <ModelPreparationCard
              stepLabel={stepLabels.alignment!}
              title="Prepare wav2vec2 alignment model"
              description="Plain accurate and both anchor-constrained accurate modes require a wav2vec2 alignment model. Use model runs autodetect and stores the prepared selection for the next run."
              loading={loadingModelCatalogs}
              emptyMessage="No alignment models found. Add a wav2vec2 model under assets/models, PAD/documents/models, or downloads (category: alignment)."
              models={alignmentCatalog.entries}
              selectedId={selectedAlignmentModelId}
              preparedId={preparedAlignmentModelId}
              preparing={preparingAlignmentModel}
              prepareLabel="Use alignment model"
              preparedSummary={alignmentPrepareSummary}
              onSelect={setSelectedAlignmentModelId}
              onPrepare={handlePrepareAlignmentModel}
            />
          ) : null}

          {activeMode.requiresVadModel ? (
            <ModelPreparationCard
              stepLabel={stepLabels.vad!}
              title="Prepare VAD anchors"
              description="Best-practice anchor generation here follows the docs: segmentOfflineBuffer(audio, { evaluator: speech_vad_model, modelPath }). The resulting seg_off_* buffer feeds vad mode or accurate segmentation auto."
              loading={loadingModelCatalogs}
              emptyMessage="No VAD models found. Add one under assets/models, PAD/documents/models, or downloads (category: vad)."
              models={vadCatalog.entries}
              selectedId={selectedVadModelId}
              preparedId={preparedVadModelId}
              preparing={preparingVadModel}
              prepareLabel="Use VAD model"
              preparedSummary={vadPrepareSummary}
              onSelect={setSelectedVadModelId}
              onPrepare={handlePrepareVadModel}
            />
          ) : null}

          {activeMode.requiresSttModel ? (
            <ModelPreparationCard
              stepLabel={stepLabels.stt!}
              title="Prepare STT hypothesis model"
              description="asr_mediated requires a real hypothesis buffer H. Use model runs STT detection now; the run step then creates STT, writes H via stt.transcribe(audio, H), and passes that buffer into alignment."
              loading={loadingModelCatalogs}
              emptyMessage="No STT models found. Add one under assets/models, PAD/documents/models, or downloads (category: stt)."
              models={sttCatalog.entries}
              selectedId={selectedSttModelId}
              preparedId={preparedSttModelId}
              preparing={preparingSttModel}
              prepareLabel="Use STT model"
              preparedSummary={sttPrepareSummary}
              onSelect={setSelectedSttModelId}
              onPrepare={handlePrepareSttModel}
            />
          ) : null}

          <SectionCard
            stepLabel={stepLabels.run}
            title="Run offline alignment"
            description="This step creates fresh offline buffers, runs only the selected public mode, reads alignment segments from segmentOut, and then releases buffers and destroys engines in finally."
          >
            <View style={styles.resultCard}>
              <Text style={styles.resultMetaText}>Pipeline summary</Text>
              <Text style={styles.resultCodeText}>
                mode: {activeMode.title}
              </Text>
              <Text style={styles.resultCodeText}>
                native mode: {activeMode.apiMode}
              </Text>
              <Text style={styles.resultCodeText}>
                granularity: {granularity}
              </Text>
              <Text style={styles.resultCodeText}>
                alignment model:{' '}
                {activeMode.requiresAlignmentModel
                  ? preparedAlignmentModelId ?? 'missing'
                  : 'not required'}
              </Text>
              {activeMode.requiresAlignmentModel ? (
                <Text style={styles.resultCodeText}>
                  alignment detect: {preparedAlignmentModelType ?? 'unknown'} ·{' '}
                  {preparedAlignmentModelPath ?? 'path unavailable'}
                </Text>
              ) : null}
              <Text style={styles.resultCodeText}>
                VAD model:{' '}
                {activeMode.requiresVadModel
                  ? preparedVadModelId ?? 'missing'
                  : 'not required'}
              </Text>
              {activeMode.requiresVadModel ? (
                <Text style={styles.resultCodeText}>
                  VAD detect: {preparedVadModelType ?? 'unknown'} ·{' '}
                  {preparedVadModelPath ?? 'path unavailable'}
                </Text>
              ) : null}
              <Text style={styles.resultCodeText}>
                STT model:{' '}
                {activeMode.requiresSttModel
                  ? preparedSttModelId ?? 'missing'
                  : 'not required'}
              </Text>
              {activeMode.requiresSttModel ? (
                <Text style={styles.resultCodeText}>
                  STT detect: {preparedSttModelType ?? 'unknown'}
                </Text>
              ) : null}
            </View>

            {runBlockingIssues.length > 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningBannerText}>
                  Resolve these inputs before running:
                </Text>
                {runBlockingIssues.map((issue) => (
                  <Text key={issue} style={styles.warningListItem}>
                    • {issue}
                  </Text>
                ))}
              </View>
            ) : (
              <View style={styles.readyCard}>
                <Ionicons name="checkmark-circle" size={18} color="#1B5E20" />
                <Text style={styles.readyText}>Pipeline is ready to run.</Text>
              </View>
            )}

            <Pressable
              style={[
                styles.button,
                styles.generateButton,
                (running || runBlockingIssues.length > 0) &&
                  styles.buttonDisabled,
              ]}
              onPress={handleRunAlignment}
              disabled={running || runBlockingIssues.length > 0}
            >
              {running ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>
                  {activeMode.runButtonLabel}
                </Text>
              )}
            </Pressable>
          </SectionCard>

          {error || errorCode ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>Pipeline error</Text>
              {errorCode ? (
                <Text style={styles.errorCode}>code: {errorCode}</Text>
              ) : null}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          ) : null}

          <SectionCard
            stepLabel={stepLabels.result}
            title="Result"
            description="The output shown here is derived from the alignment segments already read from segmentOut before cleanup."
          >
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
                    outputSegmentBufferId: {result.outputSegmentBufferId}
                  </Text>
                  {result.anchorSegmentBufferId ? (
                    <Text style={styles.resultCodeText}>
                      anchorSegmentBufferId: {result.anchorSegmentBufferId}
                    </Text>
                  ) : null}
                  {result.hypothesisTextBufferId ? (
                    <Text style={styles.resultCodeText}>
                      hypothesisTextBufferId: {result.hypothesisTextBufferId}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Text style={styles.resultMetaText}>Write result</Text>
                  <Text style={styles.resultCodeText}>mode: {result.mode}</Text>
                  <Text style={styles.resultCodeText}>
                    segmentsWritten: {result.segmentsWritten}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    writeDurationMs: {formatMs(result.writeDurationMs)}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    warningCode: {result.warningCode ?? 'none'}
                  </Text>
                  {result.warnings?.length ? (
                    <View style={styles.warningList}>
                      {result.warnings.map((warning) => (
                        <Text
                          key={`${warning.code}-${warning.message}`}
                          style={styles.resultCodeText}
                        >
                          {warning.code}: {warning.message}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Pressable
                    style={styles.resultAccordionHeader}
                    onPress={() => setSegmentsExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      Alignment segments ({result.alignmentSegments.length})
                    </Text>
                    <Ionicons
                      name={segmentsExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="#666"
                    />
                  </Pressable>
                  {segmentsExpanded ? (
                    result.alignmentSegments.length > 0 ? (
                      <View style={styles.subtitleList}>
                        {result.alignmentSegments.map((segment, index) => (
                          <View
                            key={`${segment.id}-${index}`}
                            style={styles.subtitleItem}
                          >
                            <Text style={styles.subtitleText}>
                              #{index + 1} [{segment.startSample} -{' '}
                              {segment.endSample}] ({segment.durationMs}ms)
                            </Text>
                            <Text style={styles.subtitleTime}>
                              {segment.payload?.text ?? '...'}
                            </Text>
                            <Text style={styles.subtitleTime}>
                              timingMode={segment.payload?.timingMode ?? 'n/a'}{' '}
                              granularity=
                              {segment.payload?.granularity ?? 'n/a'}
                            </Text>
                            {segment.payload?.tokenMetadata ? (
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
                            ) : null}
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        Output buffer completed successfully but wrote no
                        alignment segments.
                      </Text>
                    )
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Pressable
                    style={styles.resultAccordionHeader}
                    onPress={() => setSubtitlesExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      Derived subtitles ({derivedSubtitles.length})
                    </Text>
                    <Ionicons
                      name={subtitlesExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="#666"
                    />
                  </Pressable>
                  {subtitlesExpanded ? (
                    derivedSubtitles.length > 0 ? (
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
                    )
                  ) : null}
                </View>
              </>
            ) : (
              <Text style={styles.emptyText}>
                No output yet. Run one documented offline alignment mode to
                populate the result cards.
              </Text>
            )}
          </SectionCard>
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="GenerateTimestamp" />
    </SafeAreaView>
  );
}
