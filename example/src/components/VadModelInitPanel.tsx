import {
  ActivityIndicator,
  Pressable,
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
  VadCustomInitForm,
} from './modelInit';
import type { useVadModelInit } from '../hooks/useVadModelInit';

type VadInit = ReturnType<typeof useVadModelInit>;

type Props = {
  vad: VadInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function VadModelInitPanel({
  vad,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || vad.loading || vad.customFillLoading;
  const canInitCustom = !!vad.customInitForm.fileSources.model;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize VAD model</Text>
      <Text style={styles.sectionDescription}>
        Streaming Silero or Ten-VAD packs. Init builds the engine; live/offline
        runs reuse it until Rebuild or Release.
      </Text>
      <InitModeSelector
        value={vad.initMode}
        onChange={vad.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {vad.initMode === 'auto'
          ? 'Select a streaming VAD folder, then Use model.'
          : 'Fill slots from catalog (or pick files), then Initialize custom.'}
      </Text>

      {(vad.initializedSummary || vad.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {vad.initializedSummary
              ? `Initialized: ${vad.initializedSummary}`
              : `Selected: ${
                  vad.selectedModelForInit
                    ? getModelDisplayName(vad.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {vad.catalogEntries.length === 0 &&
      !vad.loadingModels &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No streaming VAD models on device. Download from Download Showcase
            (ModelCategory.Vad).
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
          entries={vad.catalogEntries}
          selectedId={vad.selectedModelForInit}
          initializedId={vad.currentModelFolder}
          onSelect={vad.setSelectedModelForInit}
          loading={vad.loadingModels}
          disabled={busy}
          emptyMessage="No streaming VAD models found."
        />
      )}

      {vad.initMode === 'custom' ? (
        <VadCustomInitForm
          value={vad.customInitForm}
          onChange={vad.setCustomInitForm}
          selectedCatalogModelId={vad.selectedModelForInit}
          onFillFromSelectedModel={() => {
            vad.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={vad.prepareScatteredTest}
          fillLoading={vad.customFillLoading}
          disabled={busy}
          fillHint={vad.customFillHint}
        />
      ) : null}

      <Text style={styles.smallLabel}>Engine options (applied at Init)</Text>
      <View style={styles.inlineRowWrap}>
        <Text style={styles.inlineLabel}>
          sampleRate: {vad.sampleRateInput}
        </Text>
        <Pressable
          style={styles.smallButton}
          onPress={() =>
            vad.setSampleRateInput((prev) =>
              prev === '16000' ? '8000' : '16000'
            )
          }
          disabled={busy}
        >
          <Text style={styles.smallButtonText}>Toggle</Text>
        </Pressable>
      </View>
      <View style={styles.inlineRowWrap}>
        <Text style={styles.inlineLabel}>threshold: {vad.thresholdInput}</Text>
        <Pressable
          style={styles.smallButton}
          onPress={() =>
            vad.setThresholdInput((prev) => (prev === '0.5' ? '0.35' : '0.5'))
          }
          disabled={busy}
        >
          <Text style={styles.smallButtonText}>Toggle</Text>
        </Pressable>
      </View>

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
          vad.initMode === 'custom' && !canInitCustom && styles.buttonDisabled,
        ]}
        onPress={() => {
          vad.applySelectedModel();
        }}
        disabled={
          busy ||
          (vad.initMode === 'auto'
            ? !vad.selectedModelForInit && !vad.currentModelFolder
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {vad.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {vad.isEngineInitialized
              ? vad.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : vad.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!vad.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          vad.releaseEngine().catch(() => {});
        }}
        disabled={!vad.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {vad.initResult && !vad.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{vad.initResult}</Text>
        </View>
      ) : null}

      {vad.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{vad.error}</Text>
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
  smallLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3A3A3C',
    marginBottom: 6,
    marginTop: 8,
  },
  inlineRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  inlineLabel: {
    flex: 1,
    fontSize: 13,
    color: '#3A3A3C',
  },
  smallButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
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
