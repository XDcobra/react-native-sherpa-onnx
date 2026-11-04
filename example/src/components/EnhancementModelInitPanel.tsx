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
  EnhancementCustomInitForm,
  InitModeSelector,
  ModelFolderGrid,
} from './modelInit';
import type { useEnhancementModelInit } from '../hooks/useEnhancementModelInit';

type EnhancementInit = ReturnType<typeof useEnhancementModelInit>;

type Props = {
  enhancement: EnhancementInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function EnhancementModelInitPanel({
  enhancement,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || enhancement.loading || enhancement.customFillLoading;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        Offline denoising (GTCRN / DPDFNet / VoxLock). Init builds the engine;
        enhancement runs reuse it until Rebuild or Release.
      </Text>
      <InitModeSelector
        value={enhancement.initMode}
        onChange={enhancement.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {enhancement.initMode === 'auto'
          ? 'Select a folder, then Use model.'
          : 'Choose model type, pick the ONNX file (or Fill from catalog), then Initialize custom.'}
      </Text>

      {(enhancement.initializedSummary ||
        enhancement.currentModelFolder ||
        enhancement.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {enhancement.initializedSummary
              ? `Initialized: ${enhancement.initializedSummary}`
              : enhancement.currentModelFolder
              ? `Loaded: ${getModelDisplayName(enhancement.currentModelFolder)}`
              : `Selected: ${
                  enhancement.selectedModelForInit
                    ? getModelDisplayName(enhancement.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {enhancement.catalogEntries.length === 0 &&
      !enhancement.loadingModels &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No enhancement models on device. Download from Download Showcase
            (ModelCategory.Enhancement).
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
          entries={enhancement.catalogEntries}
          selectedId={enhancement.selectedModelForInit}
          initializedId={enhancement.currentModelFolder}
          onSelect={enhancement.setSelectedModelForInit}
          loading={enhancement.loadingModels}
          disabled={busy}
          emptyMessage="No enhancement models found."
        />
      )}

      {enhancement.initMode === 'custom' ? (
        <EnhancementCustomInitForm
          value={enhancement.customInitForm}
          onChange={enhancement.setCustomInitForm}
          selectedCatalogModelId={enhancement.selectedModelForInit}
          onFillFromSelectedModel={() => {
            enhancement.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={enhancement.prepareScatteredTest}
          fillLoading={enhancement.customFillLoading}
          disabled={busy}
          fillHint={enhancement.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          enhancement.applySelectedModel();
        }}
        disabled={
          busy ||
          (enhancement.initMode === 'auto'
            ? !enhancement.selectedModelForInit &&
              !enhancement.currentModelFolder
            : false)
        }
      >
        <View style={styles.applyButtonContent}>
          {enhancement.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {enhancement.isEngineInitialized
              ? enhancement.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : enhancement.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!enhancement.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          enhancement.releaseEngine().catch(() => {});
        }}
        disabled={!enhancement.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {enhancement.initResult && !enhancement.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{enhancement.initResult}</Text>
        </View>
      ) : null}

      {enhancement.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{enhancement.error}</Text>
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
