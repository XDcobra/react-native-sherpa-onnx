import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  deleteModelByCategory,
  downloadModelByCategory,
  listDownloadedModelsByCategory,
  refreshModelsByCategory,
  ModelCategory,
  type DownloadProgress,
  type ModelMetaBase,
  type TtsModelMeta,
} from 'react-native-sherpa-onnx/download';
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

const normalizeFilter = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'any') return null;
  return trimmed.toLowerCase();
};

export default function ModelManagementScreen() {
  const [category, setCategory] = useState<ModelCategory>(ModelCategory.Tts);
  const [models, setModels] = useState<ModelMetaBase[]>([]);
  const [filteredModels, setFilteredModels] = useState<ModelMetaBase[]>([]);
  const [downloadedModels, setDownloadedModels] = useState<ModelMetaBase[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressById, setProgressById] = useState<
    Record<string, DownloadProgress>
  >({});

  const isTtsCategory = category === ModelCategory.Tts;
  const ttsModels = useMemo(
    () => (isTtsCategory ? (models as TtsModelMeta[]) : []),
    [isTtsCategory, models]
  );

  const downloadedIds = useMemo(() => {
    return new Set(downloadedModels.map((model) => model.id));
  }, [downloadedModels]);

  const languages = useMemo(
    () =>
      toOptionList(
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
      setFilteredModels(models);
      return;
    }

    const language = normalizeFilter(filters.language);
    const type = normalizeFilter(filters.type);
    const quantization = normalizeFilter(filters.quantization);
    const sizeTier = normalizeFilter(filters.sizeTier);

    const filtered = (models as TtsModelMeta[]).filter((model) => {
      const modelLanguages = model.languages ?? [];
      if (type && model.type !== type) return false;
      if (quantization && model.quantization !== quantization) return false;
      if (sizeTier && model.sizeTier !== sizeTier) return false;
      if (
        language &&
        !modelLanguages.map((lang) => lang.toLowerCase()).includes(language)
      ) {
        return false;
      }
      return true;
    });

    setFilteredModels(filtered);
  }, [filters, isTtsCategory, models]);

  useEffect(() => {
    loadModels().catch(() => undefined);
  }, [loadModels, category]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleCategoryChange = (next: ModelCategory) => {
    if (next === category) return;
    setCategory(next);
    setFilters(DEFAULT_FILTERS);
    setProgressById({});
    setModels([]);
    setFilteredModels([]);
    setDownloadedModels([]);
  };

  const currentCategory = CATEGORY_OPTIONS.find(
    (option) => option.key === category
  );

  const handleDownload = async (model: ModelMetaBase) => {
    if (downloadedIds.has(model.id)) {
      return;
    }

    setProgressById((prev) => ({
      ...prev,
      [model.id]: { bytesDownloaded: 0, totalBytes: model.bytes, percent: 0 },
    }));

    try {
      await downloadModelByCategory<ModelMetaBase>(category, model.id, {
        onProgress: (progress) => {
          setProgressById((prev) => ({ ...prev, [model.id]: progress }));
        },
      });
      await loadDownloaded();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Download failed', message);
    } finally {
      setProgressById((prev) => {
        const next = { ...prev };
        delete next[model.id];
        return next;
      });
    }
  };

  const handleDelete = async (model: ModelMetaBase) => {
    Alert.alert('Delete model', `Remove ${model.displayName}?`, [
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

  const renderFilterRow = (
    label: string,
    options: string[],
    value: string,
    onChange: (next: string) => void
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
                {option}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
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

        {loading && (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color="#007AFF" />
            <Text style={styles.loadingText}>Loading models...</Text>
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

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
            <Text style={styles.categoryHelper}>{currentCategory.helper}</Text>
          )}
        </View>

        {isTtsCategory && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Filters</Text>
            {renderFilterRow('Language', languages, filters.language, (next) =>
              updateFilter('language', next)
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
            {renderFilterRow('Size', sizeTiers, filters.sizeTier, (next) =>
              updateFilter('sizeTier', next)
            )}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Available Models</Text>
          {filteredModels.length === 0 ? (
            <Text style={styles.emptyText}>
              {isTtsCategory
                ? 'No models match these filters.'
                : 'No models available for this category.'}
            </Text>
          ) : (
            filteredModels.map((model) => {
              const progress = progressById[model.id];
              const isDownloaded = downloadedIds.has(model.id);
              const ttsModel = model as TtsModelMeta;
              return (
                <View key={model.id} style={styles.modelRow}>
                  <View style={styles.modelInfo}>
                    <Text style={styles.modelName}>{model.displayName}</Text>
                    <Text style={styles.modelMeta}>
                      {isTtsCategory
                        ? `${ttsModel.type} · ${formatBytes(model.bytes)}`
                        : formatBytes(model.bytes)}
                    </Text>
                  </View>
                  {isDownloaded ? (
                    <Text style={styles.downloadedLabel}>Downloaded</Text>
                  ) : (
                    <TouchableOpacity
                      style={styles.downloadButton}
                      onPress={() => handleDownload(model)}
                      disabled={Boolean(progress)}
                    >
                      {progress ? (
                        <Text style={styles.downloadButtonText}>
                          {Math.round(progress.percent)}%
                        </Text>
                      ) : (
                        <Text style={styles.downloadButtonText}>Download</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              );
            })
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Downloaded Models</Text>
          {downloadedModels.length === 0 ? (
            <Text style={styles.emptyText}>No cached models yet.</Text>
          ) : (
            downloadedModels.map((model) => (
              <View key={model.id} style={styles.modelRow}>
                <View style={styles.modelInfo}>
                  <Text style={styles.modelName}>{model.displayName}</Text>
                  <Text style={styles.modelMeta}>{model.id}</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={() => handleDelete(model)}
                >
                  <Ionicons name="trash" size={18} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
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
  deleteButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    padding: 8,
  },
  emptyText: {
    fontSize: 12,
    color: '#8E8E93',
  },
});
