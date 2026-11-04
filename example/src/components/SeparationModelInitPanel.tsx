import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  ModelFolderGrid,
  SeparationCustomInitForm,
} from './modelInit';
import type { useSeparationModelInit } from '../hooks/useSeparationModelInit';

type SeparationInit = ReturnType<typeof useSeparationModelInit>;

type Props = {
  separation: SeparationInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function SeparationModelInitPanel({
  separation,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || separation.loading || separation.customFillLoading;
  const canInitCustom =
    Object.keys(separation.customInitForm.fileSources).length > 0;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        Offline Spleeter or UVR/MDX separation. Init builds the engine; batch
        and live runs reuse it until Rebuild or Release.
      </Text>
      <InitModeSelector
        value={separation.initMode}
        onChange={separation.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {separation.initMode === 'auto'
          ? 'Select a folder, then Use model.'
          : 'Choose model type, pick stem ONNX files (or Fill from catalog), then Initialize custom.'}
      </Text>

      {(separation.initializedSummary ||
        separation.currentModelFolder ||
        separation.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {separation.initializedSummary
              ? `Initialized: ${separation.initializedSummary}${
                  separation.modelSampleRate != null
                    ? ` • ${separation.numStems} stem(s) @ ${separation.modelSampleRate} Hz`
                    : ''
                }`
              : separation.currentModelFolder
              ? `Loaded: ${getModelDisplayName(separation.currentModelFolder)}`
              : `Selected: ${
                  separation.selectedModelForInit
                    ? getModelDisplayName(separation.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {separation.catalogEntries.length === 0 &&
      !separation.loadingModels &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No separation models on device. Download from Download Showcase
            (ModelCategory.Separation).
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
          entries={separation.catalogEntries}
          selectedId={separation.selectedModelForInit}
          initializedId={separation.currentModelFolder}
          onSelect={separation.setSelectedModelForInit}
          loading={separation.loadingModels}
          disabled={busy}
          emptyMessage="No separation models found."
        />
      )}

      {separation.initMode === 'custom' ? (
        <SeparationCustomInitForm
          value={separation.customInitForm}
          onChange={separation.setCustomInitForm}
          selectedCatalogModelId={separation.selectedModelForInit}
          onFillFromSelectedModel={() => {
            separation.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={separation.prepareScatteredTest}
          fillLoading={separation.customFillLoading}
          disabled={busy}
          fillHint={separation.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          separation.applySelectedModel();
        }}
        disabled={
          busy ||
          (separation.initMode === 'auto'
            ? !separation.selectedModelForInit && !separation.currentModelFolder
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {separation.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {separation.isEngineInitialized
              ? separation.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : separation.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!separation.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          separation.releaseEngine().catch(() => {});
        }}
        disabled={!separation.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {separation.initResult && !separation.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{separation.initResult}</Text>
        </View>
      ) : null}

      {separation.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{separation.error}</Text>
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
