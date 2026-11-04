import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  ModelFolderGrid,
  DiarizationOfflineCustomInitForm,
} from './modelInit';
import type { useDiarizationModelInit } from '../hooks/useDiarizationModelInit';
import { styles as screenStyles } from '../screens/diarization/DiarizationScreen.styles';

type DiarizationInit = ReturnType<typeof useDiarizationModelInit>;

type Props = {
  diarization: DiarizationInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function DiarizationModelInitPanel({
  diarization: dia,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy =
    disabled || dia.loading || dia.customFillLoading || dia.loadingSegCatalog;
  const canInitCustom =
    dia.customInitForm.segmentationSource != null &&
    dia.customInitForm.embeddingSource != null;
  const [tuningExpanded, setTuningExpanded] = useState(false);
  const { tuning, patchTuning } = dia;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Model Setup & Tuning</Text>
      <Text style={styles.sectionDescription}>
        Pyannote / Reverb segmentation + WeSpeaker / 3D-Speaker embeddings. Init
        builds the engine; diarize and recluster reuse it until Rebuild or
        Release.
      </Text>

      <InitModeSelector
        value={dia.initMode}
        onChange={(mode) => {
          dia.setInitMode(mode);
          dia.setError(null);
        }}
        disabled={busy}
      />

      {dia.initializedSummary && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            Initialized: {dia.initializedSummary}
            {dia.engineInfo?.sampleRate
              ? ` • ${dia.engineInfo.sampleRate} Hz`
              : ''}
          </Text>
        </View>
      )}

      {dia.initMode === 'auto' ? (
        <Text style={styles.sectionDescription}>
          Select segmentation and embedding folders, then Initialize engine.
        </Text>
      ) : (
        <Text style={styles.sectionDescription}>
          Optional: select catalog folders to Fill custom paths, or use
          Scattered test.
        </Text>
      )}

      <Text style={screenStyles.sectionTitle}>
        {n1}a. Segmentation Model (Pyannote / Reverb)
      </Text>
      {dia.segCatalogEntries.length === 0 &&
      !dia.loadingSegCatalog &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No segmentation models on device. Download from Download Showcase
            (ModelCategory.Diarization).
          </Text>
          <TouchableOpacity
            style={styles.downloadButton}
            onPress={onOpenDownloads}
            disabled={busy}
          >
            <Ionicons name="cloud-download-outline" size={16} color="#FFFFFF" />
            <Text style={styles.downloadButtonText}>Open Download Screen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ModelFolderGrid
          entries={dia.segCatalogEntries}
          selectedId={dia.selectedSegId}
          initializedId={dia.currentSegModelId}
          onSelect={(id) => {
            dia.setSelectedSegId(id);
            dia.setError(null);
          }}
          loading={dia.loadingSegCatalog}
          disabled={busy}
          emptyMessage="No segmentation models found."
        />
      )}

      <Text style={screenStyles.sectionTitle}>
        {n1}b. Speaker Embedding Model (WeSpeaker / 3D-Speaker)
      </Text>
      {dia.embCatalogEntries.length === 0 &&
      !dia.loadingEmbCatalog &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No speaker-embedding models on device. Download from Download
            Showcase (ModelCategory.SpeakerEmbedding).
          </Text>
          <TouchableOpacity
            style={styles.downloadButton}
            onPress={onOpenDownloads}
            disabled={busy}
          >
            <Ionicons name="cloud-download-outline" size={16} color="#FFFFFF" />
            <Text style={styles.downloadButtonText}>Open Download Screen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ModelFolderGrid
          entries={dia.embCatalogEntries}
          selectedId={dia.selectedEmbId}
          initializedId={dia.currentEmbModelId}
          onSelect={(id) => {
            dia.setSelectedEmbId(id);
            dia.setError(null);
          }}
          loading={dia.loadingEmbCatalog}
          disabled={busy}
          emptyMessage="No speaker-embedding models found."
        />
      )}

      {dia.initMode === 'custom' ? (
        <DiarizationOfflineCustomInitForm
          value={dia.customInitForm}
          onChange={dia.setCustomInitForm}
          selectedSegCatalogModelId={dia.selectedSegId}
          selectedEmbCatalogModelId={dia.selectedEmbId}
          onFillSegmentationFromCatalog={() => {
            dia.fillSegmentationFromCatalog().catch(() => {});
          }}
          onFillEmbeddingFromCatalog={() => {
            dia.fillEmbeddingFromCatalog().catch(() => {});
          }}
          onPrepareScatteredTest={dia.prepareScatteredTest}
          fillLoading={dia.customFillLoading}
          disabled={busy}
          fillHint={dia.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[screenStyles.secondaryButton, screenStyles.marginTop12]}
        onPress={() => setTuningExpanded((v) => !v)}
        disabled={disabled}
      >
        <Ionicons
          name={tuningExpanded ? 'chevron-up' : 'options-outline'}
          size={18}
          color="#374151"
        />
        <Text style={screenStyles.secondaryButtonText}>
          {tuningExpanded
            ? 'Hide Diarization Tuning'
            : 'Advanced Diarization Tuning'}
        </Text>
      </TouchableOpacity>

      {tuningExpanded ? (
        <View style={screenStyles.tuningSectionContent}>
          <View style={screenStyles.paramRow}>
            <View style={screenStyles.flex1}>
              <Text style={screenStyles.paramLabel}>Clustering Threshold</Text>
              {tuning.numClusters > 0 && (
                <Text style={screenStyles.cardSubtitle}>
                  Ignored when cluster count is fixed
                </Text>
              )}
            </View>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    clusteringThreshold: Math.max(
                      0.1,
                      Math.round((tuning.clusteringThreshold - 0.05) * 100) /
                        100
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.clusteringThreshold.toFixed(2)}
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    clusteringThreshold: Math.min(
                      1.0,
                      Math.round((tuning.clusteringThreshold + 0.05) * 100) /
                        100
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={screenStyles.paramRow}>
            <Text style={screenStyles.paramLabel}>
              Fixed Number of Clusters
            </Text>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    numClusters: Math.max(0, tuning.numClusters - 1),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.numClusters === 0 ? 'Auto' : tuning.numClusters}
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    numClusters: Math.min(8, tuning.numClusters + 1),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={screenStyles.paramRow}>
            <View style={screenStyles.flex1}>
              <Text style={screenStyles.paramLabel}>
                Compute segment confidence
              </Text>
              <Text style={screenStyles.cardSubtitle}>
                Silhouette score per turn [-1, 1]. Default off (SDK parity).
                Re-run diarize after toggling.
              </Text>
            </View>
            <Switch
              value={tuning.computeConfidence}
              onValueChange={(value) =>
                patchTuning({ computeConfidence: value })
              }
              disabled={disabled}
              accessibilityLabel="Compute segment confidence"
            />
          </View>

          <View style={screenStyles.paramRow}>
            <Text style={screenStyles.paramLabel}>
              Min Speech Turn Duration
            </Text>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    minDurationOn: Math.max(
                      0.0,
                      Math.round((tuning.minDurationOn - 0.1) * 10) / 10
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.minDurationOn.toFixed(1)}s
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    minDurationOn: Math.min(
                      2.0,
                      Math.round((tuning.minDurationOn + 0.1) * 10) / 10
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={screenStyles.paramRow}>
            <Text style={screenStyles.paramLabel}>Max Gap to Merge Turns</Text>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    minDurationOff: Math.max(
                      0.0,
                      Math.round((tuning.minDurationOff - 0.1) * 10) / 10
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.minDurationOff.toFixed(1)}s
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    minDurationOff: Math.min(
                      2.0,
                      Math.round((tuning.minDurationOff + 0.1) * 10) / 10
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={screenStyles.paramRow}>
            <Text style={screenStyles.paramLabel}>
              Sliding Window Hop Ratio
            </Text>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    windowShiftRatio: Math.max(
                      0.05,
                      Math.round((tuning.windowShiftRatio - 0.05) * 100) / 100
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.windowShiftRatio.toFixed(2)}
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    windowShiftRatio: Math.min(
                      0.5,
                      Math.round((tuning.windowShiftRatio + 0.05) * 100) / 100
                    ),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={screenStyles.paramRow}>
            <View style={screenStyles.flex1}>
              <Text style={screenStyles.paramLabel}>Inference Threads</Text>
              <Text style={screenStyles.cardSubtitle}>
                Parallel CPU threads for model forward passes
              </Text>
            </View>
            <View style={screenStyles.paramControls}>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    numThreads: Math.max(1, tuning.numThreads - 1),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={screenStyles.paramValueBadge}>
                <Text style={screenStyles.paramValueText}>
                  {tuning.numThreads}
                </Text>
              </View>
              <TouchableOpacity
                style={screenStyles.paramStepButton}
                onPress={() =>
                  patchTuning({
                    numThreads: Math.min(8, tuning.numThreads + 1),
                  })
                }
                disabled={disabled}
              >
                <Text style={screenStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          dia.applySelectedModel().catch(() => {});
        }}
        disabled={
          busy ||
          (dia.initMode === 'auto'
            ? (!dia.selectedSegId && !dia.currentSegModelId) ||
              (!dia.selectedEmbId && !dia.currentEmbModelId)
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {dia.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="hardware-chip-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {dia.isEngineInitialized
              ? dia.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild engine'
              : dia.initMode === 'custom'
              ? 'Initialize custom'
              : 'Initialize engine'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!dia.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          dia.releaseEngine().catch(() => {});
        }}
        disabled={!dia.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {dia.engineInfo ? (
        <View style={screenStyles.metaGrid}>
          <View style={screenStyles.metaBadge}>
            <Text style={screenStyles.metaBadgeLabel}>Sample Rate</Text>
            <Text style={screenStyles.metaBadgeValue}>
              {dia.engineInfo.sampleRate} Hz
            </Text>
          </View>
          <View style={screenStyles.metaBadge}>
            <Text style={screenStyles.metaBadgeLabel}>Clustering Mode</Text>
            <Text style={screenStyles.metaBadgeValue}>
              {dia.engineInfo.numClusters > 0
                ? `${dia.engineInfo.numClusters} clusters (fixed)`
                : `Threshold ${dia.engineInfo.threshold.toFixed(2)}`}
            </Text>
          </View>
          <View style={screenStyles.metaBadge}>
            <Text style={screenStyles.metaBadgeLabel}>Confidence</Text>
            <Text style={screenStyles.metaBadgeValue}>
              {dia.engineInfo.computeConfidence ? 'On' : 'Off'}
            </Text>
          </View>
        </View>
      ) : null}

      {dia.initResult && !dia.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{dia.initResult}</Text>
        </View>
      ) : null}

      {dia.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{dia.error}</Text>
        </View>
      ) : null}

      {(dia.selectedSegId || dia.currentSegModelId) &&
      !dia.initializedSummary ? (
        <Text style={styles.sectionDescription}>
          Selected seg:{' '}
          {getModelDisplayName(
            dia.selectedSegId ?? dia.currentSegModelId ?? ''
          )}
          {' • '}
          emb:{' '}
          {getModelDisplayName(
            dia.selectedEmbId ?? dia.currentEmbModelId ?? ''
          )}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  currentModelContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  currentModelText: {
    fontSize: 14,
    color: '#3A3A3C',
    fontWeight: '500',
  },
  emptyCatalog: {
    marginBottom: 8,
  },
  downloadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  downloadButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    marginTop: 10,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#1D4ED8',
    fontSize: 15,
    fontWeight: '600',
  },
  applyButton: {
    marginTop: 16,
  },
  applyButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  resultContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  resultText: {
    fontSize: 14,
    color: '#000000',
  },
  errorContainer: {
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  errorLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#C62828',
    marginBottom: 4,
  },
  errorText: {
    fontSize: 14,
    color: '#C62828',
  },
});
