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
  EngineModeToggle,
  InitModeSelector,
  ModelFolderGrid,
  SttCustomInitForm,
  StreamingSttCustomInitForm,
} from './modelInit';
import type { useSttStreamingModelInit } from '../hooks/useSttStreamingModelInit';

type SttStreamingInit = ReturnType<typeof useSttStreamingModelInit>;

type Props = {
  stt: SttStreamingInit;
  sectionStart?: number;
  disabled?: boolean;
};

export function SttStreamingModelInitPanel({
  stt,
  sectionStart = 1,
  disabled = false,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || stt.loading || stt.customFillLoading;
  const isCustom = stt.initMode === 'custom';
  // Rebuild only when the live engine matches the selected Streaming / Live Overload mode.
  const engineMatchesMode =
    (stt.engineMode === 'streaming' && stt.activeEngineKind === 'streaming') ||
    (stt.engineMode === 'offline' &&
      stt.activeEngineKind === 'offline-overload');
  const showRebuild = engineMatchesMode;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        Build the streaming or Live Overload STT engine once; pipeline runs
        reuse it until Rebuild or Release.
      </Text>

      <EngineModeToggle
        value={stt.engineMode}
        onChange={stt.setEngineMode}
        disabled={busy}
      />
      <Text style={styles.modeHint}>
        {stt.engineMode === 'streaming'
          ? 'Incremental live decoding with streaming-capable models.'
          : 'Offline STT weights with mandatory segmentation on live buffers.'}
      </Text>

      <InitModeSelector
        value={stt.initMode}
        onChange={stt.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {isCustom
          ? 'Choose model type, pick ONNX files (or Fill from catalog), then Initialize custom.'
          : 'Select a model folder, then tap Use model for auto-detection.'}
      </Text>

      {(stt.initializedSummary ||
        stt.currentModelFolder ||
        stt.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {showRebuild && stt.initializedSummary
              ? `Initialized: ${stt.initializedSummary}`
              : stt.selectedModelForInit
              ? `Selected: ${getModelDisplayName(stt.selectedModelForInit)}`
              : stt.currentModelFolder
              ? `Loaded: ${getModelDisplayName(stt.currentModelFolder)}`
              : stt.initializedSummary
              ? `Other mode initialized: ${stt.initializedSummary}`
              : ''}
          </Text>
        </View>
      )}

      <ModelFolderGrid
        entries={stt.catalogEntriesForMode}
        selectedId={stt.selectedModelForInit}
        initializedId={stt.currentModelFolder}
        onSelect={stt.setSelectedModelForInit}
        loading={stt.loadingModels}
        disabled={busy}
        emptyMessage={
          stt.engineMode === 'streaming'
            ? 'No streaming-capable STT models found.'
            : 'No offline-capable STT models found for Live Overload.'
        }
      />

      {isCustom && stt.engineMode === 'streaming' ? (
        <StreamingSttCustomInitForm
          value={stt.customInitForm}
          onChange={stt.setCustomInitForm}
          selectedCatalogModelId={stt.selectedModelForInit}
          onFillFromSelectedModel={() => {
            stt.fillFromSelectedModel().catch(() => {});
          }}
          fillLoading={stt.customFillLoading}
          disabled={busy}
          fillHint={stt.customFillHint}
        />
      ) : null}

      {isCustom && stt.engineMode === 'offline' ? (
        <SttCustomInitForm
          value={stt.offlineCustomInitForm}
          onChange={stt.setOfflineCustomInitForm}
          selectedCatalogModelId={stt.selectedModelForInit}
          onFillFromSelectedModel={() => {
            stt.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={stt.prepareScatteredTest}
          fillLoading={stt.customFillLoading}
          disabled={busy}
          fillHint={stt.customFillHint}
          showScatteredTest
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          stt.applySelectedModel();
        }}
        disabled={
          busy ||
          (!isCustom && !stt.selectedModelForInit && !stt.currentModelFolder)
        }
      >
        <View style={styles.applyButtonContent}>
          {stt.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {showRebuild
              ? isCustom
                ? 'Rebuild custom'
                : 'Rebuild model'
              : isCustom
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!stt.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          stt.releaseEngine().catch(() => {});
        }}
        disabled={!stt.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {stt.initResult && !stt.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{stt.initResult}</Text>
        </View>
      ) : null}

      {stt.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{stt.error}</Text>
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
  modeHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: -4,
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
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
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
  resultContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  resultText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 4,
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
