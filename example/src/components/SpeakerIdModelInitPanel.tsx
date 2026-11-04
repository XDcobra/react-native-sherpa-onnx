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
  SpeakerIdentificationCustomInitForm,
} from './modelInit';
import type { useSpeakerIdModelInit } from '../hooks/useSpeakerIdModelInit';

type SpeakerIdInit = ReturnType<typeof useSpeakerIdModelInit>;

type Props = {
  speakerId: SpeakerIdInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function SpeakerIdModelInitPanel({
  speakerId: sid,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || sid.loading || sid.customFillLoading;
  const canInitCustom = Object.keys(sid.customInitForm.fileSources).length > 0;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        WeSpeaker / 3D-Speaker / NeMo speaker embeddings. Init builds the
        engine; enroll and identify runs reuse it until Rebuild or Release.
      </Text>
      <InitModeSelector
        value={sid.initMode}
        onChange={sid.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {sid.initMode === 'auto'
          ? 'Select a folder, then Use model.'
          : 'Choose model type, pick the embedding ONNX (or Fill from catalog), then Initialize custom.'}
      </Text>

      {(sid.initializedSummary ||
        sid.currentModelFolder ||
        sid.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {sid.initializedSummary
              ? `Initialized: ${sid.initializedSummary}${
                  sid.modelDim != null ? ` • dim ${sid.modelDim}` : ''
                }`
              : sid.currentModelFolder
              ? `Loaded: ${getModelDisplayName(sid.currentModelFolder)}`
              : `Selected: ${
                  sid.selectedModelForInit
                    ? getModelDisplayName(sid.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {sid.catalogEntries.length === 0 &&
      !sid.loadingModels &&
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
          entries={sid.catalogEntries}
          selectedId={sid.selectedModelForInit}
          initializedId={sid.currentModelFolder}
          onSelect={sid.setSelectedModelForInit}
          loading={sid.loadingModels}
          disabled={busy}
          emptyMessage="No speaker-embedding models found."
        />
      )}

      {sid.initMode === 'custom' ? (
        <SpeakerIdentificationCustomInitForm
          value={sid.customInitForm}
          onChange={sid.setCustomInitForm}
          selectedCatalogModelId={sid.selectedModelForInit}
          onFillFromSelectedModel={() => {
            sid.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={sid.prepareScatteredTest}
          fillLoading={sid.customFillLoading}
          disabled={busy}
          fillHint={sid.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          sid.applySelectedModel();
        }}
        disabled={
          busy ||
          (sid.initMode === 'auto'
            ? !sid.selectedModelForInit && !sid.currentModelFolder
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {sid.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {sid.isEngineInitialized
              ? sid.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : sid.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!sid.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          sid.releaseEngine().catch(() => {});
        }}
        disabled={!sid.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {sid.initResult && !sid.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{sid.initResult}</Text>
        </View>
      ) : null}

      {sid.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{sid.error}</Text>
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
