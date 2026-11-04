import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getModelDisplayName } from '../modelConfig';
import {
  AudioTaggingCustomInitForm,
  InitModeSelector,
  ModelFolderGrid,
} from './modelInit';
import {
  AUDIO_TAGGING_TOP_K_OPTIONS,
  type useAudioTaggingModelInit,
} from '../hooks/useAudioTaggingModelInit';

type AtInit = ReturnType<typeof useAudioTaggingModelInit>;

type Props = {
  audioTagging: AtInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function AudioTaggingModelInitPanel({
  audioTagging: at,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const n2 = sectionStart + 1;
  const busy = disabled || at.loading || at.customFillLoading;
  const canInitCustom =
    !!at.customInitForm.fileSources.model &&
    !!at.customInitForm.fileSources.labels;

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
        <InitModeSelector
          value={at.initMode}
          onChange={at.setInitMode}
          disabled={busy}
        />
        <Text style={styles.sectionDescription}>
          {at.initMode === 'auto'
            ? 'Select a CED or zipformer pack, then Use model.'
            : 'Pick model ONNX + labels CSV (or Fill from catalog), then Initialize custom.'}
        </Text>

        {(at.initializedSummary || at.selectedModelForInit) && (
          <View style={styles.currentModelContainer}>
            <Text style={styles.currentModelText}>
              {at.initializedSummary
                ? `Initialized: ${at.initializedSummary}`
                : `Selected: ${
                    at.selectedModelForInit
                      ? getModelDisplayName(at.selectedModelForInit)
                      : ''
                  }`}
            </Text>
          </View>
        )}

        {at.catalogEntries.length === 0 &&
        !at.loadingModels &&
        onOpenDownloads ? (
          <View style={styles.emptyCatalog}>
            <Text style={styles.sectionDescription}>
              No audio tagging models found. Download from Download Showcase.
            </Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={onOpenDownloads}
              disabled={busy}
            >
              <Text style={styles.secondaryButtonText}>
                Open Download Showcase
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ModelFolderGrid
            entries={at.catalogEntries}
            selectedId={at.selectedModelForInit}
            initializedId={at.currentModelFolder}
            onSelect={at.setSelectedModelForInit}
            loading={at.loadingModels}
            disabled={busy}
            emptyMessage="No audio tagging models found."
          />
        )}

        {at.initMode === 'custom' ? (
          <AudioTaggingCustomInitForm
            value={at.customInitForm}
            onChange={at.setCustomInitForm}
            selectedCatalogModelId={at.selectedModelForInit}
            onFillFromSelectedModel={() => {
              at.fillFromSelectedModel().catch(() => {});
            }}
            onPrepareScatteredTest={at.prepareScatteredTest}
            fillLoading={at.customFillLoading}
            disabled={busy}
            fillHint={at.customFillHint}
          />
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{n2}. Engine options</Text>
        <Text style={styles.smallLabel}>topK (create default)</Text>
        <View style={styles.chipRow}>
          {AUDIO_TAGGING_TOP_K_OPTIONS.map((value) => (
            <TouchableOpacity
              key={value}
              style={[styles.chip, at.topK === value && styles.chipSelected]}
              onPress={() => at.setTopK(value)}
              disabled={busy}
            >
              <Text style={styles.chipText}>{value}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.applyButton,
            busy && styles.buttonDisabled,
            at.initMode === 'custom' && !canInitCustom && styles.buttonDisabled,
          ]}
          onPress={() => {
            at.applySelectedModel();
          }}
          disabled={
            busy ||
            (at.initMode === 'auto'
              ? !at.selectedModelForInit && !at.currentModelFolder
              : !canInitCustom)
          }
        >
          <View style={styles.applyButtonContent}>
            {at.loading ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                style={styles.applyButtonSpinner}
              />
            ) : null}
            <Text style={styles.primaryButtonText}>
              {at.initMode === 'custom' ? 'Initialize custom' : 'Use model'}
            </Text>
          </View>
        </TouchableOpacity>

        {at.initResult && !at.error ? (
          <View style={styles.resultContainer}>
            <Text style={styles.resultText}>{at.initResult}</Text>
          </View>
        ) : null}

        {at.error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorLabel}>Error:</Text>
            <Text style={styles.errorText}>{at.error}</Text>
          </View>
        ) : null}
      </View>
    </>
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
  smallLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3A3A3C',
    marginBottom: 6,
    marginTop: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  chip: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  chipText: {
    fontSize: 13,
    color: '#000000',
    fontWeight: '500',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyButton: {
    marginTop: 16,
  },
  applyButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  applyButtonSpinner: {
    marginRight: 2,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 15,
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
