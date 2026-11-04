import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  LanguageIdentificationCustomInitForm,
  ModelFolderGrid,
} from './modelInit';
import type { useLanguageIdModelInit } from '../hooks/useLanguageIdModelInit';

type LidInit = ReturnType<typeof useLanguageIdModelInit>;

type Props = {
  languageId: LidInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function LanguageIdModelInitPanel({
  languageId: lid,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || lid.loading || lid.customFillLoading;
  const canInitCustom =
    !!lid.customInitForm.fileSources.encoder &&
    !!lid.customInitForm.fileSources.decoder;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        Multilingual Whisper (encoder + decoder). Prefer tiny/base for mobile
        latency; English-only packs are filtered out.
      </Text>
      <InitModeSelector
        value={lid.initMode}
        onChange={lid.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {lid.initMode === 'auto'
          ? 'Select a Whisper multilingual pack, then Use model.'
          : 'Pick encoder + decoder ONNX (or Fill from catalog), then Initialize custom.'}
      </Text>

      {(lid.initializedSummary || lid.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {lid.initializedSummary
              ? `Initialized: ${lid.initializedSummary}`
              : `Selected: ${
                  lid.selectedModelForInit
                    ? getModelDisplayName(lid.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {lid.catalogEntries.length === 0 &&
      !lid.loadingModels &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No Whisper multilingual models found. Download an STT Whisper pack
            (or Language ID category) from Download Showcase.
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
          entries={lid.catalogEntries}
          selectedId={lid.selectedModelForInit}
          initializedId={lid.currentModelFolder}
          onSelect={lid.setSelectedModelForInit}
          loading={lid.loadingModels}
          disabled={busy}
          emptyMessage="No Language ID / Whisper models found."
        />
      )}

      {lid.initMode === 'custom' ? (
        <LanguageIdentificationCustomInitForm
          value={lid.customInitForm}
          onChange={lid.setCustomInitForm}
          selectedCatalogModelId={lid.selectedModelForInit}
          onFillFromSelectedModel={() => {
            lid.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={lid.prepareScatteredTest}
          fillLoading={lid.customFillLoading}
          disabled={busy}
          fillHint={lid.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
          lid.initMode === 'custom' && !canInitCustom && styles.buttonDisabled,
        ]}
        onPress={() => {
          lid.applySelectedModel();
        }}
        disabled={
          busy ||
          (lid.initMode === 'auto'
            ? !lid.selectedModelForInit && !lid.currentModelFolder
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {lid.loading ? (
            <ActivityIndicator
              size="small"
              color="#FFFFFF"
              style={styles.applyButtonSpinner}
            />
          ) : null}
          <Text style={styles.primaryButtonText}>
            {lid.initMode === 'custom' ? 'Initialize custom' : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      {lid.loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Initializing model...</Text>
        </View>
      ) : null}

      {lid.initResult && !lid.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{lid.initResult}</Text>
        </View>
      ) : null}

      {lid.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{lid.error}</Text>
        </View>
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
  loadingContainer: {
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#8E8E93',
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
