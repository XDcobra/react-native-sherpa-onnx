import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import {
  ModelCategory,
  downloadModel,
  pauseDownload,
  resumeDownload,
  deleteIncompleteDownload,
  refreshModels,
  getModelById,
  listDownloadedModelsWithMetadata,
  onProgress,
  pauseExtraction,
  resumeExtraction,
  deleteIncompleteExtraction,
  deleteModel,
  getIncompleteExtractions,
  isActiveExtractionPhase,
  isPauseError,
  type ModelWithMetadata,
  type Progress,
} from 'react-native-sherpa-onnx/download';
import { styles } from './DownloadShowcaseScreen.styles';

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  [ModelCategory.Stt]: 'Speech-to-text (STT)',
  [ModelCategory.Tts]: 'Text-to-speech (TTS)',
  [ModelCategory.Vad]: 'VAD',
  [ModelCategory.Diarization]: 'Diarization',
  [ModelCategory.Enhancement]: 'Enhancement',
  [ModelCategory.Separation]: 'Separation',
  [ModelCategory.Qnn]: 'QNN',
  [ModelCategory.Alignment]: 'Alignment',
};

const ALL_CATEGORIES = Object.values(ModelCategory);

type RunPhase = 'idle' | 'running' | 'paused';

export default function DownloadShowcaseScreen() {
  const [category, setCategory] = useState<ModelCategory>(ModelCategory.Tts);
  const [modelId, setModelId] = useState('vits-piper-en_US-lessac-medium');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  /** True only while validating before downloadModel (blocks double Start, not Stop). */
  const [preparing, setPreparing] = useState(false);
  /** True during Resume / Clear / Stop handler — does not disable Stop while downloading. */
  const [busy, setBusy] = useState(false);

  const [downloadPct, setDownloadPct] = useState(0);
  const [extractPct, setExtractPct] = useState(0);
  const [lastProgress, setLastProgress] = useState<Progress | null>(null);

  const [downloadedByCategory, setDownloadedByCategory] = useState<
    Partial<Record<ModelCategory, ModelWithMetadata[]>>
  >({});
  const [expanded, setExpanded] = useState<
    Partial<Record<ModelCategory, boolean>>
  >(() => ({ [ModelCategory.Tts]: true, [ModelCategory.Stt]: true }));

  const [error, setError] = useState<string | null>(null);
  /** `category:modelId` while deleteModel is in flight for that row */
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const activeKeyRef = useRef<string | null>(null);
  const lastPhaseRef = useRef<Progress['phase'] | null>(null);

  const loadDownloaded = useCallback(async () => {
    const next: Partial<Record<ModelCategory, ModelWithMetadata[]>> = {};
    await Promise.all(
      ALL_CATEGORIES.map(async (cat) => {
        try {
          next[cat] = await listDownloadedModelsWithMetadata(cat);
        } catch {
          next[cat] = [];
        }
      })
    );
    setDownloadedByCategory(next);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadDownloaded();
    }, [loadDownloaded])
  );

  useEffect(() => {
    const unsub = onProgress((cat, id, p) => {
      const key = `${cat}:${id}`;
      if (activeKeyRef.current !== key) return;
      lastPhaseRef.current = p.phase;
      setLastProgress(p);
      if (p.phase === 'downloading') {
        setDownloadPct(p.percent);
      } else if (isActiveExtractionPhase(p.phase)) {
        setExtractPct(p.percent);
      }
    });
    return unsub;
  }, []);

  const resetProgressBars = useCallback(() => {
    setDownloadPct(0);
    setExtractPct(0);
    setLastProgress(null);
    lastPhaseRef.current = null;
  }, []);

  const handleStart = async () => {
    const id = modelId.trim();
    if (!id) {
      setError('Enter a model id');
      return;
    }
    setError(null);
    resetProgressBars();
    activeKeyRef.current = `${category}:${id}`;
    setRunPhase('running');
    setPreparing(true);

    try {
      await refreshModels(category, { forceRefresh: false });
      const meta = await getModelById(category, id);
      if (!meta) {
        setError(
          `Unknown model "${id}" in ${category}. Try refreshModels with forceRefresh, or check the id.`
        );
        setRunPhase('idle');
        activeKeyRef.current = null;
        return;
      }

      // Must clear before downloadModel: Stop must stay enabled during long download/extract.
      setPreparing(false);

      await downloadModel(category, id, {
        onProgress: (p) => {
          lastPhaseRef.current = p.phase;
          setLastProgress(p);
          if (p.phase === 'downloading') setDownloadPct(p.percent);
          if (isActiveExtractionPhase(p.phase)) setExtractPct(p.percent);
        },
      });

      setRunPhase('idle');
      activeKeyRef.current = null;
      setDownloadPct(100);
      if (meta.archiveExt === 'tar.bz2') {
        setExtractPct(100);
      }
      await loadDownloaded();
    } catch (e) {
      if (isPauseError(e)) {
        setRunPhase('paused');
        activeKeyRef.current = null;
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setRunPhase('idle');
        activeKeyRef.current = null;
      }
    } finally {
      setPreparing(false);
    }
  };

  const handlePauseDownload = async () => {
    const id = modelId.trim();
    if (!id) return;
    setBusy(true);
    try {
      await pauseDownload(category, id);
    } catch (err) {
      console.warn('[DownloadShowcase] pauseDownload failed', err);
    } finally {
      setBusy(false);
    }
  };

  const handlePauseExtraction = async () => {
    const id = modelId.trim();
    if (!id) return;
    setBusy(true);
    try {
      await pauseExtraction(category, id);
    } catch (err) {
      console.warn('[DownloadShowcase] pauseExtraction failed', err);
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    const id = modelId.trim();
    if (!id) return;
    setError(null);
    setBusy(true);
    activeKeyRef.current = `${category}:${id}`;
    setRunPhase('running');

    try {
      const incompleteExt = await getIncompleteExtractions(category);
      const hasPausedExtraction = incompleteExt.some((s) => s.modelId === id);

      if (hasPausedExtraction) {
        await resumeExtraction(category, id, {
          onProgress: (p) => {
            lastPhaseRef.current = p.phase;
            setLastProgress(p);
            if (p.phase === 'downloading') setDownloadPct(p.percent);
            if (isActiveExtractionPhase(p.phase)) setExtractPct(p.percent);
          },
        });
      } else {
        await resumeDownload(category, id, {
          onProgress: (p) => {
            lastPhaseRef.current = p.phase;
            setLastProgress(p);
            if (p.phase === 'downloading') setDownloadPct(p.percent);
            if (isActiveExtractionPhase(p.phase)) setExtractPct(p.percent);
          },
        });
      }

      setRunPhase('idle');
      activeKeyRef.current = null;
      await loadDownloaded();
    } catch (e) {
      if (isPauseError(e)) {
        setRunPhase('paused');
        activeKeyRef.current = null;
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setRunPhase('paused');
        activeKeyRef.current = null;
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = () => {
    const id = modelId.trim();
    if (!id) return;

    Alert.alert(
      'Clear progress',
      'Removes incomplete download and extraction state (including the partial archive and extracted files) for this model.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await deleteIncompleteExtraction(category, id);
              await deleteIncompleteDownload(category, id);
              setRunPhase('idle');
              activeKeyRef.current = null;
              resetProgressBars();
              await loadDownloaded();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const toggleAccordion = (cat: ModelCategory) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const handleDeleteDownloaded = (cat: ModelCategory, id: string) => {
    Alert.alert(
      'Delete model',
      `Remove "${id}" from this device (extracted files, manifest, and any archive copy in the models folder)?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            const key = `${cat}:${id}`;
            setDeletingKey(key);
            setError(null);
            deleteModel(cat, id)
              .then(() => loadDownloaded())
              .catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              })
              .finally(() => {
                setDeletingKey((k) => (k === key ? null : k));
              });
          },
        },
      ]
    );
  };

  const statusLabel = useMemo(() => {
    if (preparing) return 'Preparing (registry)…';
    if (runPhase === 'paused') return 'Paused — resume or clear';
    if (runPhase === 'running') {
      if (lastProgress?.phase === 'extracting_resume_skipping') {
        return 'Resuming extraction (scanning archive)…';
      }
      if (lastProgress && isActiveExtractionPhase(lastProgress.phase)) {
        return 'Extracting…';
      }
      return 'Downloading…';
    }
    return 'Idle';
  }, [preparing, runPhase, lastProgress]);

  const canPauseDownload =
    runPhase === 'running' &&
    !preparing &&
    lastProgress &&
    !isActiveExtractionPhase(lastProgress.phase);

  const canPauseExtract =
    runPhase === 'running' &&
    !preparing &&
    lastProgress &&
    isActiveExtractionPhase(lastProgress.phase);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.sectionTitle}>Download target</Text>
        <View style={styles.card}>
          <Text style={styles.progressLabel}>Category</Text>
          <TouchableOpacity
            style={styles.pickerButton}
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
          >
            <Text style={styles.pickerButtonText}>
              {CATEGORY_LABELS[category]}
            </Text>
            <Text style={{ color: '#8E8E93', fontSize: 18 }}>▾</Text>
          </TouchableOpacity>

          <Text style={[styles.progressLabel, { marginTop: 12 }]}>
            Model id
          </Text>
          <TextInput
            style={styles.input}
            value={modelId}
            onChangeText={setModelId}
            placeholder="e.g. vits-piper-en_US-lessac-medium"
            placeholderTextColor="#C7C7CC"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>

        <Text style={styles.sectionTitle}>Progress</Text>
        <View style={styles.card}>
          <Text style={styles.progressLabel}>Download</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.min(100, downloadPct)}%` },
              ]}
            />
          </View>
          <Text style={styles.progressMeta}>
            {lastProgress?.phase === 'downloading'
              ? `${Math.round(downloadPct)}% · ${
                  lastProgress.bytesProcessed
                } / ${lastProgress.totalBytes} B`
              : '—'}
          </Text>

          <Text style={styles.progressLabel}>Extraction</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                styles.progressFillExtract,
                { width: `${Math.min(100, extractPct)}%` },
              ]}
            />
          </View>
          <Text style={styles.progressMeta}>
            {lastProgress && isActiveExtractionPhase(lastProgress.phase)
              ? `${Math.round(extractPct)}% · ${
                  lastProgress.bytesProcessed
                } / ${lastProgress.totalBytes} B${
                  lastProgress.phase === 'extracting_resume_skipping'
                    ? ' · resume scan'
                    : ''
                }`
              : '—'}
          </Text>

          <View style={styles.statusRow}>
            {preparing || busy ? (
              <ActivityIndicator size="small" color="#8E8E93" />
            ) : null}
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>

          {runPhase !== 'paused' ? (
            <>
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[
                    styles.btn,
                    styles.btnPrimary,
                    (runPhase === 'running' || preparing) &&
                      styles.btnPrimaryDisabled,
                  ]}
                  disabled={runPhase === 'running' || preparing}
                  onPress={() => void handleStart()}
                >
                  <Text style={styles.btnTextLight}>Start</Text>
                </TouchableOpacity>
              </View>
              <Text
                style={[styles.progressMeta, { marginBottom: 8, marginTop: 4 }]}
              >
                While running: pause the active phase. Download pauses the
                background task; extraction appears after the archive is
                complete.
              </Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnOutline]}
                  disabled={!canPauseDownload}
                  onPress={() => void handlePauseDownload()}
                >
                  <Text style={styles.btnTextDark}>Pause download</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnOutline]}
                  disabled={!canPauseExtract}
                  onPress={() => void handlePauseExtraction()}
                >
                  <Text style={styles.btnTextDark}>Pause extract</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.btnPrimary,
                  busy && styles.btnPrimaryDisabled,
                ]}
                disabled={busy}
                onPress={() => void handleResume()}
              >
                <Text style={styles.btnTextLight}>Resume</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnOutline]}
                disabled={busy}
                onPress={handleDiscard}
              >
                <Text style={styles.btnTextDark}>Clear</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <Text style={styles.sectionTitle}>Downloaded models</Text>
        <View style={styles.card}>
          {ALL_CATEGORIES.map((cat) => {
            const list = downloadedByCategory[cat] ?? [];
            const isOpen = expanded[cat] ?? false;
            return (
              <View key={cat}>
                <TouchableOpacity
                  style={styles.accordionHeader}
                  onPress={() => toggleAccordion(cat)}
                  accessibilityRole="button"
                >
                  <Text style={styles.accordionTitle}>
                    {CATEGORY_LABELS[cat]} ({list.length})
                  </Text>
                  <Text style={styles.accordionChevron}>
                    {isOpen ? '▼' : '▶'}
                  </Text>
                </TouchableOpacity>
                {isOpen ? (
                  list.length === 0 ? (
                    <Text style={styles.emptyHint}>No models</Text>
                  ) : (
                    list.map((m) => {
                      const rowKey = `${cat}:${m.model.id}`;
                      const isDeleting = deletingKey === rowKey;
                      const showDelete = m.status === 'ready';
                      return (
                        <View key={m.model.id} style={styles.modelRow}>
                          <View style={styles.modelRowInner}>
                            <View style={styles.modelRowMain}>
                              <Text style={styles.modelId}>{m.model.id}</Text>
                              <Text style={styles.modelMeta}>
                                {m.status}
                                {m.progress != null
                                  ? ` · ${Math.round(m.progress)}%`
                                  : ''}
                                {m.sizeOnDisk != null
                                  ? ` · ${m.sizeOnDisk} B`
                                  : ''}
                              </Text>
                            </View>
                            {showDelete ? (
                              <TouchableOpacity
                                style={styles.deleteModelBtn}
                                disabled={isDeleting}
                                onPress={() =>
                                  handleDeleteDownloaded(cat, m.model.id)
                                }
                                accessibilityRole="button"
                                accessibilityLabel={`Delete ${m.model.id}`}
                              >
                                {isDeleting ? (
                                  <ActivityIndicator
                                    size="small"
                                    color="#FF3B30"
                                  />
                                ) : (
                                  <Text style={styles.deleteModelBtnText}>
                                    Delete
                                  </Text>
                                )}
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                      );
                    })
                  )
                ) : null}
              </View>
            );
          })}
        </View>
      </ScrollView>

      <Modal visible={pickerOpen} transparent animationType="fade">
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setPickerOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>Category</Text>
            <ScrollView>
              {ALL_CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat}
                  style={styles.modalItem}
                  onPress={() => {
                    setCategory(cat);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={styles.modalItemText}>
                    {CATEGORY_LABELS[cat]}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
