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
  deleteTtsModel,
  downloadTtsModel,
  filterTtsModels,
  listDownloadedTtsModels,
  refreshTtsModels,
  type DownloadProgress,
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

const formatBytes = (bytes: number) => {
  if (!bytes) return 'Unknown size';
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
};

const toOptionList = (values: string[]) => {
  const unique = Array.from(new Set(values)).filter(Boolean).sort();
  return ['Any', ...unique];
};

export default function ModelManagementScreen() {
  const [models, setModels] = useState<TtsModelMeta[]>([]);
  const [filteredModels, setFilteredModels] = useState<TtsModelMeta[]>([]);
  const [downloadedModels, setDownloadedModels] = useState<TtsModelMeta[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressById, setProgressById] = useState<
    Record<string, DownloadProgress>
  >({});

  const downloadedIds = useMemo(() => {
    return new Set(downloadedModels.map((model) => model.id));
  }, [downloadedModels]);

  const languages = useMemo(
    () =>
      toOptionList(
        models.flatMap((model) => model.languages.map((lang) => lang))
      ),
    [models]
  );

  const types = useMemo(
    () => toOptionList(models.map((model) => model.type)),
    [models]
  );

  const quantizations = useMemo(
    () => toOptionList(models.map((model) => model.quantization)),
    [models]
  );

  const sizeTiers = useMemo(
    () => toOptionList(models.map((model) => model.sizeTier)),
    [models]
  );

  const loadDownloaded = useCallback(async () => {
    const downloaded = await listDownloadedTtsModels();
    setDownloadedModels(downloaded);
  }, []);

  const loadModels = useCallback(
    async (forceRefresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const registry = await refreshTtsModels({ forceRefresh });
        setModels(registry);
        await loadDownloaded();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(`Failed to load models: ${message}`);
      } finally {
        setLoading(false);
      }
    },
    [loadDownloaded]
  );

  const applyFilters = useCallback(async () => {
    const filtered = await filterTtsModels({
      language: filters.language,
      type: filters.type,
      quantization: filters.quantization,
      sizeTier: filters.sizeTier,
    });
    setFilteredModels(filtered);
  }, [filters]);

  useEffect(() => {
    loadModels().catch(() => undefined);
  }, [loadModels]);

  useEffect(() => {
    applyFilters().catch(() => undefined);
  }, [applyFilters]);

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleDownload = async (model: TtsModelMeta) => {
    if (downloadedIds.has(model.id)) {
      return;
    }

    setProgressById((prev) => ({
      ...prev,
      [model.id]: { bytesDownloaded: 0, totalBytes: model.bytes, percent: 0 },
    }));

    try {
      await downloadTtsModel(model.id, {
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

  const handleDelete = async (model: TtsModelMeta) => {
    Alert.alert('Delete model', `Remove ${model.displayName}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTtsModel(model.id);
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.filterOptions}>
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
        </View>
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
              Download, filter, and delete TTS models
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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Available Models</Text>
          {filteredModels.length === 0 ? (
            <Text style={styles.emptyText}>No models match these filters.</Text>
          ) : (
            filteredModels.map((model) => {
              const progress = progressById[model.id];
              const isDownloaded = downloadedIds.has(model.id);
              return (
                <View key={model.id} style={styles.modelRow}>
                  <View style={styles.modelInfo}>
                    <Text style={styles.modelName}>{model.displayName}</Text>
                    <Text style={styles.modelMeta}>
                      {model.type} · {formatBytes(model.bytes)}
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
