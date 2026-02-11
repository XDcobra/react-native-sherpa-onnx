import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TextInput } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import {
  deleteModelByCategory,
  downloadModelByCategory,
  listDownloadedModelsByCategory,
  refreshModelsByCategory,
  ModelCategory,
  type DownloadProgress,
  type ModelMetaBase,
  type Quantization,
  type SizeTier,
  type TtsModelMeta,
} from 'react-native-sherpa-onnx/download';
import type { STTModelType } from 'react-native-sherpa-onnx/stt';
import type { TTSModelType } from 'react-native-sherpa-onnx/tts';
import { Ionicons } from '@react-native-vector-icons/ionicons';

type FilterState = {
  language: string;
  type: string;
  quantization: string;
  sizeTier: string;
};

const DEFAULT_FILTERS: FilterState = {
  language: 'Any',
  type: 'Any',
  quantization: 'Any',
  sizeTier: 'Any',
};

const CATEGORY_OPTIONS: Array<{
  key: ModelCategory;
  label: string;
  helper: string;
}> = [
  {
    key: ModelCategory.Tts,
    label: 'TTS',
    helper: 'Text-to-speech voices',
  },
  {
    key: ModelCategory.Stt,
    label: 'STT',
    helper: 'Speech-to-text models',
  },
  {
    key: ModelCategory.Vad,
    label: 'VAD',
    helper: 'Voice activity detection',
  },
  {
    key: ModelCategory.Diarization,
    label: 'Diarization',
    helper: 'Who-spoke-when models',
  },
  {
    key: ModelCategory.Enhancement,
    label: 'Enhancement',
    helper: 'Speech denoise/enhance',
  },
  {
    key: ModelCategory.Separation,
    label: 'Separation',
    helper: 'Source separation',
  },
];

const formatBytes = (bytes: number) => {
  if (!bytes) return 'Unknown size';
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
};

const toOptionList = (values: string[]) => {
  const unique = Array.from(new Set(values)).filter(Boolean).sort();
  return ['Any', ...unique];
};

const normalizeLanguageCode = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const primary = trimmed.toLowerCase().split(/[-_]/)[0] ?? '';
  if (primary.length !== 2) return null;
  if (!/^[a-z]{2}$/.test(primary)) return null;
  return primary;
};

const toLanguageOptionList = (values: Array<string | null | undefined>) => {
  const normalized = values
    .map((value) => normalizeLanguageCode(value))
    .filter((value): value is string => Boolean(value));
  return toOptionList(normalized);
};

const getFlagEmoji = (code: string) => {
  if (!/^[a-z]{2}$/i.test(code)) return null;
  const upper = code.toUpperCase();
  const base = 0x1f1e6;
  const first = upper.charCodeAt(0) - 65 + base;
  const second = upper.charCodeAt(1) - 65 + base;
  return String.fromCodePoint(first, second);
};

const getLanguageLabel = (code: string) => {
  if (code.toLowerCase() === 'any') return 'Any';
  const normalized = normalizeLanguageCode(code) ?? code.toLowerCase();
  const flag = getFlagEmoji(normalized);
  const upper = normalized.toUpperCase();
  return flag ? `${flag} ${upper}` : upper;
};

const normalizeFilter = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'any') return null;
  return trimmed.toLowerCase();
};

const getModelQuantization = (modelId: string): Quantization => {
  const lower = modelId.toLowerCase();
  if (lower.includes('int8') && lower.includes('quant')) {
    return 'int8-quantized';
  }
  if (lower.includes('int8')) return 'int8';
  if (lower.includes('fp16')) return 'fp16';
  return 'unknown';
};

const getModelSizeTier = (modelId: string): SizeTier => {
  const lower = modelId.toLowerCase();
  if (lower.includes('tiny')) return 'tiny';
  if (lower.includes('small')) return 'small';
  if (lower.includes('medium')) return 'medium';
  if (lower.includes('large')) return 'large';
  if (lower.includes('low')) return 'small';
  return 'unknown';
};

const getTtsModelType = (modelId: string): TTSModelType | null => {
  const lower = modelId.toLowerCase();
  if (lower.includes('vits')) return 'vits';
  if (lower.includes('matcha')) return 'matcha';
  if (lower.includes('kokoro')) return 'kokoro';
  if (lower.includes('kitten')) return 'kitten';
  if (lower.includes('zipvoice')) return 'zipvoice';
  return null;
};

const getSttModelType = (modelId: string): STTModelType | null => {
  const lower = modelId.toLowerCase();
  if (lower.includes('whisper')) return 'whisper';
  if (lower.includes('paraformer')) return 'paraformer';
  if (lower.includes('zipformer') || lower.includes('transducer')) {
    return 'transducer';
  }
  if (lower.includes('wenet')) return 'wenet_ctc';
  if (lower.includes('sense-voice') || lower.includes('sensevoice')) {
    return 'sense_voice';
  }
  if (lower.includes('funasr')) return 'funasr_nano';
  if (lower.includes('nemo') || lower.includes('parakeet')) {
    return 'nemo_ctc';
  }
  return null;
};

const getLanguageCodeFromModelId = (modelId: string) => {
  const normalized = modelId.toLowerCase();
  const match = normalized.match(/(?:^|[_-])([a-z]{2})(?:[_-]|$)/);
  const code = match?.[1];
  if (!code) return null;
  return normalizeLanguageCode(code);
};

const isUnsupportedModel = (model: ModelMetaBase, category: ModelCategory) => {
  if (category === ModelCategory.Tts) {
    return getTtsModelType(model.id) === null;
  }
  if (category === ModelCategory.Stt) {
    return getSttModelType(model.id) === null;
  }
  // For other categories, assume supported for now
  return false;
};

const getUnsupportedMessage = () =>
  'This model is not yet supported. We are working to add support in a future version.';

type DownloadTrackerSnapshot = Record<string, DownloadProgress>;

type DownloadedListItem = {
  id: string;
  displayName: string;
  isActive: boolean;
  isAborted?: boolean;
  progress?: DownloadProgress;
};

const downloadTrackerByCategory: Partial<
  Record<ModelCategory, DownloadTrackerSnapshot>
> = {};

const downloadTrackerListeners = new Set<
  (category: ModelCategory, snapshot: DownloadTrackerSnapshot) => void
>();
const downloadAbortControllers = new Map<string, AbortController>();

const getDownloadTrackerSnapshot = (category: ModelCategory) => {
  if (!downloadTrackerByCategory[category]) {
    downloadTrackerByCategory[category] = {};
  }
  return downloadTrackerByCategory[category]!;
};

const emitDownloadTracker = (category: ModelCategory) => {
  const snapshot = { ...getDownloadTrackerSnapshot(category) };
  downloadTrackerByCategory[category] = snapshot;
  downloadTrackerListeners.forEach((listener) => listener(category, snapshot));
};

const setDownloadTrackerProgress = (
  category: ModelCategory,
  modelId: string,
  progress: DownloadProgress
) => {
  const current = getDownloadTrackerSnapshot(category);
  downloadTrackerByCategory[category] = { ...current, [modelId]: progress };
  emitDownloadTracker(category);
};

const clearDownloadTrackerProgress = (
  category: ModelCategory,
  modelId: string
) => {
  const current = getDownloadTrackerSnapshot(category);
  const next = { ...current };
  delete next[modelId];
  downloadTrackerByCategory[category] = next;
  emitDownloadTracker(category);
};

const subscribeDownloadTracker = (
  listener: (category: ModelCategory, snapshot: DownloadTrackerSnapshot) => void
) => {
  downloadTrackerListeners.add(listener);
  return () => {
    downloadTrackerListeners.delete(listener);
  };
};

const makeDownloadKey = (category: ModelCategory, modelId: string) =>
  `${category}:${modelId}`;

const setDownloadAbortController = (
  category: ModelCategory,
  modelId: string,
  controller: AbortController
) => {
  downloadAbortControllers.set(makeDownloadKey(category, modelId), controller);
};

const clearDownloadAbortController = (
  category: ModelCategory,
  modelId: string
) => {
  downloadAbortControllers.delete(makeDownloadKey(category, modelId));
};

const cancelDownloadById = (category: ModelCategory, modelId: string) => {
  const key = makeDownloadKey(category, modelId);
  const controller = downloadAbortControllers.get(key);
  if (controller) {
    controller.abort();
    downloadAbortControllers.delete(key);
  }
  clearDownloadTrackerProgress(category, modelId);
};

export default function ModelManagementScreen() {
  const [category, setCategory] = useState<ModelCategory>(ModelCategory.Tts);
  const [models, setModels] = useState<ModelMetaBase[]>([]);
  const [filteredModels, setFilteredModels] = useState<ModelMetaBase[]>([]);
  const [downloadedModels, setDownloadedModels] = useState<ModelMetaBase[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressById, setProgressById] = useState<
    Record<string, DownloadProgress>
  >({});
  const [downloadedExpanded, setDownloadedExpanded] = useState(true);
  const [availableExpanded, setAvailableExpanded] = useState(true);
  const [abortingById, setAbortingById] = useState<Record<string, boolean>>({});
  const [recentlyAbortedById, setRecentlyAbortedById] = useState<
    Record<string, { id: string; displayName: string }>
  >({});
  const loggedUnsupportedRef = useRef<Set<string>>(new Set());

  const isTtsCategory = category === ModelCategory.Tts;
  const isSttCategory = category === ModelCategory.Stt;
  const ttsModels = useMemo(
    () => (isTtsCategory ? (models as TtsModelMeta[]) : []),
    [isTtsCategory, models]
  );
  const sttModels = useMemo(
    () => (isSttCategory ? models : []),
    [isSttCategory, models]
  );

  const downloadedIds = useMemo(() => {
    return new Set(downloadedModels.map((model) => model.id));
  }, [downloadedModels]);

  const modelsById = useMemo(() => {
    return new Map(models.map((model) => [model.id, model]));
  }, [models]);

  const hasActiveDownloads = useMemo(
    () => Object.keys(progressById).length > 0,
    [progressById]
  );

  const downloadedListItems = useMemo<DownloadedListItem[]>(() => {
    const activeItems = Object.entries(progressById)
      .filter(([id]) => !downloadedIds.has(id))
      .map(([id, progress]) => {
        const meta = modelsById.get(id);
        return {
          id,
          displayName: meta?.displayName ?? id,
          progress,
          isActive: true,
        };
      });

    const abortedItems = Object.values(recentlyAbortedById).filter(
      (item) => !downloadedIds.has(item.id) && !progressById[item.id]
    );

    const downloadedItems = downloadedModels.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isActive: false,
    }));

    return [
      ...activeItems,
      ...abortedItems.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        isActive: false,
        isAborted: true,
      })),
      ...downloadedItems.map((item) => ({
        ...item,
        isActive: false,
      })),
    ];
  }, [
    downloadedIds,
    downloadedModels,
    modelsById,
    progressById,
    recentlyAbortedById,
  ]);

  const languages = useMemo(
    () =>
      toLanguageOptionList(
        ttsModels.flatMap((model) =>
          (model.languages ?? []).map((lang) => lang)
        )
      ),
    [ttsModels]
  );

  const types = useMemo(
    () => toOptionList(ttsModels.map((model) => model.type)),
    [ttsModels]
  );

  const quantizations = useMemo(
    () => toOptionList(ttsModels.map((model) => model.quantization)),
    [ttsModels]
  );

  const sizeTiers = useMemo(
    () => toOptionList(ttsModels.map((model) => model.sizeTier)),
    [ttsModels]
  );

  const sttTypes = useMemo(() => {
    const sttTypeValues = sttModels
      .map((model) => getSttModelType(model.id))
      .filter((value): value is STTModelType => Boolean(value));
    return toOptionList(sttTypeValues);
  }, [sttModels]);

  const sttLanguages = useMemo(() => {
    const sttLanguageValues = sttModels
      .map((model) => getLanguageCodeFromModelId(model.id))
      .filter((value): value is string => Boolean(value));
    return toLanguageOptionList(sttLanguageValues);
  }, [sttModels]);

  const sttQuantizations = useMemo(() => {
    const sttQuantValues = sttModels.map((model) =>
      getModelQuantization(model.id)
    );
    return toOptionList(sttQuantValues);
  }, [sttModels]);

  const sttSizeTiers = useMemo(() => {
    const sizes = sttModels.map((model) => getModelSizeTier(model.id));
    return toOptionList(sizes);
  }, [sttModels]);

  const loadDownloaded = useCallback(async () => {
    const downloaded = await listDownloadedModelsByCategory<ModelMetaBase>(
      category
    );
    setDownloadedModels(downloaded);
  }, [category]);

  const loadModels = useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const registry = isTtsCategory
          ? await refreshModelsByCategory<TtsModelMeta>(category, {
              forceRefresh,
            })
          : await refreshModelsByCategory<ModelMetaBase>(category, {
              forceRefresh,
            });
        setModels(registry);
        await loadDownloaded();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(`Failed to load models: ${message}`);
      } finally {
        setLoading(false);
      }
    },
    [category, isTtsCategory, loadDownloaded]
  );

  const applyFilters = useCallback(() => {
    if (!isTtsCategory) {
      if (isSttCategory) {
        const type = normalizeFilter(filters.type);
        const language = normalizeFilter(filters.language);
        const search = (searchQuery || '').trim().toLowerCase();
        const quantization = normalizeFilter(filters.quantization);
        const sizeTier = normalizeFilter(filters.sizeTier);
        const filtered = models.filter((model) => {
          if (language) {
            const modelLanguage = getLanguageCodeFromModelId(model.id);
            if (modelLanguage !== language) return false;
          }
          if (type && getSttModelType(model.id) !== type) return false;
          if (quantization && getModelQuantization(model.id) !== quantization) {
            return false;
          }
          if (sizeTier && getModelSizeTier(model.id) !== sizeTier) return false;
          if (search) {
            const queryTokensArr = Array.from(
              new Set(
                search
                  .split(/\s+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            );
            const name = model.displayName?.toLowerCase() ?? '';
            const nameTokens = name
              .split(/\s+|[-_.]+/)
              .map((s) => s.trim())
              .filter(Boolean);

            if (queryTokensArr.length > 1) {
              // require all query tokens to appear in the model name
              const allQueryInName = queryTokensArr.every((q) =>
                nameTokens.includes(q)
              );
              if (!allQueryInName) return false;
            } else {
              const q = queryTokensArr[0];
              if (q && !nameTokens.some((t) => t.includes(q))) return false;
            }
          }
          return true;
        });
        setFilteredModels(filtered);
        return;
      }

      setFilteredModels(models);
      return;
    }

    const language = normalizeFilter(filters.language);
    const type = normalizeFilter(filters.type);
    const quantization = normalizeFilter(filters.quantization);
    const sizeTier = normalizeFilter(filters.sizeTier);
    const search = (searchQuery || '').trim().toLowerCase();

    const filtered = (models as TtsModelMeta[]).filter((model) => {
      const modelLanguages = model.languages ?? [];
      if (type && model.type !== type) return false;
      if (quantization && model.quantization !== quantization) return false;
      if (sizeTier && model.sizeTier !== sizeTier) return false;
      if (
        language &&
        !modelLanguages
          .map((lang) => normalizeLanguageCode(lang))
          .filter((lang): lang is string => Boolean(lang))
          .includes(language)
      ) {
        return false;
      }
      if (search) {
        const queryTokensArr = Array.from(
          new Set(
            search
              .split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean)
          )
        );
        const name = model.displayName?.toLowerCase() ?? '';
        const nameTokens = name
          .split(/\s+|[-_.]+/)
          .map((s) => s.trim())
          .filter(Boolean);

        if (queryTokensArr.length > 1) {
          const allQueryInName = queryTokensArr.every((q) =>
            nameTokens.includes(q)
          );
          if (!allQueryInName) return false;
        } else {
          const q = queryTokensArr[0];
          if (q && !nameTokens.some((t) => t.includes(q))) return false;
        }
      }
      return true;
    });

    setFilteredModels(filtered);
  }, [filters, isSttCategory, isTtsCategory, models, searchQuery]);

  useEffect(() => {
    loadModels().catch(() => undefined);
  }, [loadModels, category]);

  useEffect(() => {
    setProgressById(getDownloadTrackerSnapshot(category));
    const unsubscribe = subscribeDownloadTracker((nextCategory, snapshot) => {
      if (nextCategory !== category) return;
      setProgressById(snapshot);
    });
    return unsubscribe;
  }, [category]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  useEffect(() => {
    const logged = loggedUnsupportedRef.current;
    models.forEach((model) => {
      if (isUnsupportedModel(model, category) && !logged.has(model.id)) {
        console.log(
          `[Models] Unsupported model listed: ${model.id} (${
            model.displayName ?? model.id
          })`
        );
        logged.add(model.id);
      }
    });
  }, [models, category]);

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleCategoryChange = (next: ModelCategory) => {
    if (next === category) return;
    setCategory(next);
    setFilters(DEFAULT_FILTERS);
    setSearchQuery('');
    setProgressById({});
    setModels([]);
    setFilteredModels([]);
    setDownloadedModels([]);
  };

  const currentCategory = CATEGORY_OPTIONS.find(
    (option) => option.key === category
  );

  const handleDownload = useCallback(
    async (model: ModelMetaBase) => {
      if (downloadedIds.has(model.id)) {
        return;
      }

      const controller = new AbortController();
      setDownloadAbortController(category, model.id, controller);

      setDownloadTrackerProgress(category, model.id, {
        bytesDownloaded: 0,
        totalBytes: model.bytes,
        percent: 0,
        phase: 'downloading',
      });

      try {
        await downloadModelByCategory<ModelMetaBase>(category, model.id, {
          onProgress: (progress) => {
            setDownloadTrackerProgress(category, model.id, progress);
          },
          signal: controller.signal,
        });
        await loadDownloaded();
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.message.toLowerCase().includes('abort'))
        ) {
          // User cancelled - do nothing, handleCancelDownload already set up the UI
          return;
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('Download error (not abort):', err);
        Alert.alert('Download failed', message);
      } finally {
        clearDownloadTrackerProgress(category, model.id);
        clearDownloadAbortController(category, model.id);
      }
    },
    [category, downloadedIds, loadDownloaded]
  );

  const handleDelete = async (model: { id: string; displayName?: string }) => {
    Alert.alert('Delete model', `Remove ${model.displayName ?? model.id}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteModelByCategory(category, model.id);
          await loadDownloaded();
        },
      },
    ]);
  };

  const handleCancelDownload = useCallback(
    (model: { id: string; displayName?: string }) => {
      setAbortingById((prev) => ({ ...prev, [model.id]: true }));
      setRecentlyAbortedById((prev) => ({
        ...prev,
        [model.id]: {
          id: model.id,
          displayName: model.displayName ?? model.id,
        },
      }));

      cancelDownloadById(category, model.id);

      setTimeout(() => {
        setAbortingById((prev) => {
          const next = { ...prev };
          delete next[model.id];
          return next;
        });
        setRecentlyAbortedById((prev) => {
          const next = { ...prev };
          delete next[model.id];
          return next;
        });
      }, 1500);
    },
    [category]
  );

  const renderAvailableModel = useCallback(
    ({ item, index }: { item: ModelMetaBase; index: number }) => {
      const progress = progressById[item.id];
      const isDownloaded = downloadedIds.has(item.id);
      const isUnsupported = isUnsupportedModel(item, category);
      const ttsModel = item as TtsModelMeta;
      const sttType = getSttModelType(item.id);
      const totalCount = filteredModels.length;
      const isLast = index === totalCount - 1;

      const wrapperStyles: any[] = [styles.availableItemsWrapper];
      if (index === 0) wrapperStyles.push(styles.availableItemsWrapperFirst);
      if (isLast) wrapperStyles.push(styles.availableItemsWrapperLast);

      const rowStyles: any[] = [styles.modelRow];
      rowStyles.push(styles.modelRowPadded);
      if (isLast) rowStyles.push(styles.modelRowNoBorder);
      if (isUnsupported) rowStyles.push(styles.modelRowUnsupported);

      return (
        <View style={wrapperStyles}>
          <View style={rowStyles}>
            <View style={styles.modelInfo}>
              <Text style={styles.modelName}>{item.displayName}</Text>
              <Text style={styles.modelMeta}>
                {(() => {
                  const parts: string[] = [];

                  if (isTtsCategory) {
                    if (ttsModel.type && ttsModel.type !== 'unknown') {
                      parts.push(ttsModel.type);
                    }
                    if (
                      ttsModel.quantization &&
                      ttsModel.quantization !== 'unknown'
                    ) {
                      parts.push(ttsModel.quantization);
                    }
                    if (ttsModel.sizeTier && ttsModel.sizeTier !== 'unknown') {
                      parts.push(ttsModel.sizeTier);
                    }
                  } else if (isSttCategory && sttType) {
                    parts.push(sttType);
                    const q = getModelQuantization(item.id);
                    if (q && q !== 'unknown') parts.push(q);
                    const s = getModelSizeTier(item.id);
                    if (s && s !== 'unknown') parts.push(s);
                  }

                  parts.push(formatBytes(item.bytes));
                  return parts.join(' · ');
                })()}
              </Text>
            </View>
            {isDownloaded ? (
              <Text style={styles.downloadedLabel}>Downloaded</Text>
            ) : isUnsupported ? (
              <TouchableOpacity
                style={[
                  styles.downloadButton,
                  styles.downloadButtonUnsupported,
                ]}
                onPress={() =>
                  Alert.alert('Model not supported', getUnsupportedMessage())
                }
              >
                <Text style={styles.downloadButtonText}>Not supported</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.downloadButton}
                onPress={() => handleDownload(item)}
                disabled={Boolean(progress)}
              >
                {progress ? (
                  <Text style={styles.downloadButtonText}>
                    {progress.phase === 'extracting'
                      ? `Extracting ${Math.round(progress.percent)}%`
                      : progress.phase === 'validating'
                      ? `Validating ${Math.round(progress.percent)}%`
                      : `Downloading ${Math.round(progress.percent)}%`}
                  </Text>
                ) : (
                  <Text style={styles.downloadButtonText}>Download</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      );
    },
    [
      category,
      downloadedIds,
      handleDownload,
      isSttCategory,
      isTtsCategory,
      progressById,
      filteredModels.length,
    ]
  );

  const renderFilterRow = (
    label: string,
    options: string[],
    value: string,
    onChange: (next: string) => void,
    getLabel?: (option: string) => string
  ) => (
    <View style={styles.filterRow}>
      <Text style={styles.filterLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterOptions}
        directionalLockEnabled
        nestedScrollEnabled
      >
        {options.map((option) => {
          const isActive = option === value;
          return (
            <TouchableOpacity
              key={`${label}-${option}`}
              style={[styles.filterPill, isActive && styles.filterPillActive]}
              onPress={() => onChange(option)}
            >
              <Text
                style={[
                  styles.filterPillText,
                  isActive && styles.filterPillTextActive,
                ]}
              >
                {getLabel ? getLabel(option) : option}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlashList
        data={availableExpanded ? filteredModels : []}
        renderItem={renderAvailableModel}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        extraData={{
          downloadedIds,
          isSttCategory,
          isTtsCategory,
          progressById,
        }}
        ListHeaderComponent={
          <View>
            {/* Header */}
            <View style={styles.content}>
              <View style={styles.headerRow}>
                <View>
                  <Text style={styles.title}>Model Management</Text>
                  <Text style={styles.subtitle}>
                    {currentCategory
                      ? `Download and manage ${currentCategory.label} models`
                      : 'Download and manage models'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.reloadButton}
                  onPress={() => loadModels(true)}
                  disabled={loading}
                >
                  <Ionicons name="refresh" size={18} color="#007AFF" />
                </TouchableOpacity>
              </View>

              {loading && !hasActiveDownloads && (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color="#007AFF" />
                  <Text style={styles.loadingText}>Loading models...</Text>
                </View>
              )}

              {error && <Text style={styles.errorText}>{error}</Text>}

              {/* Categories Section */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Categories</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterOptions}
                  directionalLockEnabled
                  nestedScrollEnabled
                >
                  {CATEGORY_OPTIONS.map((option) => {
                    const isActive = option.key === category;
                    return (
                      <TouchableOpacity
                        key={option.key}
                        style={[
                          styles.filterPill,
                          isActive && styles.filterPillActive,
                        ]}
                        onPress={() => handleCategoryChange(option.key)}
                      >
                        <Text
                          style={[
                            styles.filterPillText,
                            isActive && styles.filterPillTextActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                {currentCategory && (
                  <Text style={styles.categoryHelper}>
                    {currentCategory.helper}
                  </Text>
                )}
              </View>

              {/* Filters Section */}
              {(isTtsCategory || isSttCategory) && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Filters</Text>
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search models..."
                    placeholderTextColor="#333333"
                    value={searchQuery}
                    onChangeText={(t) => setSearchQuery(t)}
                    returnKeyType="search"
                  />
                  {isTtsCategory ? (
                    <>
                      {renderFilterRow(
                        'Language',
                        languages,
                        filters.language,
                        (next) => updateFilter('language', next),
                        getLanguageLabel
                      )}
                      {renderFilterRow('Type', types, filters.type, (next) =>
                        updateFilter('type', next)
                      )}
                      {renderFilterRow(
                        'Quantization',
                        quantizations,
                        filters.quantization,
                        (next) => updateFilter('quantization', next)
                      )}
                      {renderFilterRow(
                        'Size',
                        sizeTiers,
                        filters.sizeTier,
                        (next) => updateFilter('sizeTier', next)
                      )}
                    </>
                  ) : (
                    <>
                      {renderFilterRow(
                        'Language',
                        sttLanguages,
                        filters.language,
                        (next) => updateFilter('language', next),
                        getLanguageLabel
                      )}
                      {renderFilterRow('Type', sttTypes, filters.type, (next) =>
                        updateFilter('type', next)
                      )}
                      {renderFilterRow(
                        'Quantization',
                        sttQuantizations,
                        filters.quantization,
                        (next) => updateFilter('quantization', next)
                      )}
                      {renderFilterRow(
                        'Size',
                        sttSizeTiers,
                        filters.sizeTier,
                        (next) => updateFilter('sizeTier', next)
                      )}
                    </>
                  )}
                </View>
              )}
            </View>

            {/* Downloaded Models Section */}
            <View style={[styles.section, styles.sectionInset]}>
              <TouchableOpacity
                style={styles.sectionHeaderRow}
                onPress={() => setDownloadedExpanded((s) => !s)}
              >
                <View style={styles.sectionHeaderLeft}>
                  <Text
                    style={[styles.sectionTitle, styles.sectionTitleInline]}
                  >
                    Downloaded Models
                  </Text>
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>
                      {downloadedListItems.length}
                    </Text>
                  </View>
                </View>
                <Ionicons
                  name={downloadedExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#8E8E93"
                />
              </TouchableOpacity>
              {downloadedExpanded && (
                <View style={styles.sectionInnerMarginTop}>
                  {downloadedListItems.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No downloaded models yet.
                    </Text>
                  ) : (
                    downloadedListItems.map((model) => {
                      const activeProgress = progressById[model.id];
                      const isAborting = Boolean(abortingById[model.id]);
                      return (
                        <View key={model.id} style={styles.modelRow}>
                          <View style={styles.modelInfo}>
                            <Text style={styles.modelName}>
                              {model.displayName}
                            </Text>
                            <Text style={styles.modelMeta}>{model.id}</Text>
                            {model.isActive && activeProgress && (
                              <Text style={styles.modelMeta}>
                                {activeProgress.phase === 'extracting'
                                  ? `Extracting ${Math.round(
                                      activeProgress.percent
                                    )}%`
                                  : activeProgress.phase === 'validating'
                                  ? `Validating ${Math.round(
                                      activeProgress.percent
                                    )}%`
                                  : `Downloading ${Math.round(
                                      activeProgress.percent
                                    )}%`}
                              </Text>
                            )}
                          </View>
                          {model.isActive ? (
                            <View style={styles.rowActions}>
                              <Text style={styles.downloadedLabel}>
                                In progress
                              </Text>
                              <TouchableOpacity
                                style={[
                                  styles.cancelButton,
                                  isAborting && styles.cancelButtonDisabled,
                                ]}
                                onPress={() => handleCancelDownload(model)}
                                disabled={isAborting}
                              >
                                <Ionicons
                                  name="close"
                                  size={16}
                                  color="#FFFFFF"
                                />
                              </TouchableOpacity>
                            </View>
                          ) : model.isAborted ? (
                            <Text style={styles.abortedLabel}>Canceled</Text>
                          ) : (
                            <TouchableOpacity
                              style={styles.deleteButton}
                              onPress={() => handleDelete(model)}
                            >
                              <Ionicons
                                name="trash"
                                size={18}
                                color="#FFFFFF"
                              />
                            </TouchableOpacity>
                          )}
                        </View>
                      );
                    })
                  )}
                </View>
              )}
            </View>

            {/* Available Models Section */}
            <View
              style={[
                styles.section,
                availableExpanded && filteredModels.length > 0
                  ? styles.availableSectionExpanded
                  : styles.availableSectionCollapsed,
              ]}
            >
              <TouchableOpacity
                style={styles.sectionHeaderRow}
                onPress={() => setAvailableExpanded((s) => !s)}
              >
                <View style={styles.sectionHeaderLeft}>
                  <Text
                    style={[styles.sectionTitle, styles.sectionTitleInline]}
                  >
                    Available Models
                  </Text>
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>
                      {filteredModels.length}
                    </Text>
                  </View>
                </View>
                <Ionicons
                  name={availableExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#8E8E93"
                />
              </TouchableOpacity>
            </View>
          </View>
        }
        ListEmptyComponent={
          availableExpanded && filteredModels.length === 0 ? (
            <View style={styles.emptyWrapper}>
              <Text style={styles.emptyText}>
                {isTtsCategory
                  ? 'No models match these filters.'
                  : 'No models available for this category.'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={<View style={styles.footerSpacer} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  listContent: {
    padding: 0,
  },
  content: {
    padding: 16,
    paddingBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111111',
  },
  subtitle: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 4,
  },
  reloadButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  loadingText: {
    marginLeft: 8,
    fontSize: 12,
    color: '#8E8E93',
  },
  errorText: {
    color: '#C62828',
    marginBottom: 12,
  },
  categoryHelper: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 8,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111111',
    marginBottom: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  countBadge: {
    backgroundColor: '#E5E5EA',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    marginLeft: 8,
  },
  countBadgeText: {
    fontSize: 12,
    color: '#1C1C1E',
    fontWeight: '600',
  },
  sectionTitleInline: {
    marginBottom: 0,
    lineHeight: 20,
  },
  searchInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  filterRow: {
    marginBottom: 12,
  },
  filterLabel: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 6,
  },
  filterOptions: {
    flexDirection: 'row',
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F2F2F7',
  },
  filterPillActive: {
    backgroundColor: '#007AFF',
  },
  filterPillText: {
    fontSize: 12,
    color: '#1C1C1E',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFF4',
  },
  availableItemsContainer: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
  },
  availableRowContainer: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    paddingHorizontal: 0,
    marginBottom: 0,
  },
  availableItemsWrapper: {
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    marginHorizontal: 16,
  },
  availableItemsWrapperFirst: {
    marginTop: -16,
  },
  availableItemsWrapperLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
  },
  modelRowPadded: {
    marginHorizontal: 0,
    paddingHorizontal: 16,
  },
  modelRowNoBorder: {
    borderBottomWidth: 0,
  },
  modelRowUnsupported: {
    opacity: 0.55,
  },
  modelInfo: {
    flex: 1,
    paddingRight: 12,
  },
  modelName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111111',
  },
  modelMeta: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 2,
  },
  downloadButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  downloadButtonUnsupported: {
    backgroundColor: '#C7C7CC',
  },
  downloadButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 12,
  },
  downloadedLabel: {
    fontSize: 12,
    color: '#34C759',
    fontWeight: '600',
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cancelButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  cancelButtonDisabled: {
    opacity: 0.5,
  },
  abortedLabel: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    padding: 8,
  },
  emptyText: {
    fontSize: 12,
    color: '#8E8E93',
  },
  sectionInset: {
    marginHorizontal: 16,
  },
  sectionInnerMarginTop: {
    marginTop: 8,
  },
  availableSectionExpanded: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 0,
  },
  availableSectionCollapsed: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 16,
    paddingBottom: 16,
  },
  emptyWrapper: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  footerSpacer: {
    height: 16,
  },
});
