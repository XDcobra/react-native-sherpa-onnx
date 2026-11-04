import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  KwsCustomInitForm,
  ModelFolderGrid,
} from './modelInit';
import type { useKwsModelInit } from '../hooks/useKwsModelInit';

type KwsInit = ReturnType<typeof useKwsModelInit>;

type Props = {
  kws: KwsInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function KwsModelInitPanel({
  kws,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || kws.loading || kws.customFillLoading;
  const canInitCustom =
    !!kws.customInitForm.fileSources.encoder &&
    !!kws.customInitForm.fileSources.decoder &&
    !!kws.customInitForm.fileSources.joiner &&
    !!kws.customInitForm.fileSources.tokens &&
    !!kws.customInitForm.fileSources.keywords;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize KWS model</Text>
      <Text style={styles.sectionDescription}>
        Dedicated kws-models packs (encoder/decoder/joiner/tokens +
        keywords.txt). Not interchangeable with streaming STT zipformer.
      </Text>
      <InitModeSelector
        value={kws.initMode}
        onChange={kws.setInitMode}
        disabled={busy}
      />
      <Text style={styles.sectionDescription}>
        {kws.initMode === 'auto'
          ? 'Select a KWS pack, then Use model.'
          : 'Fill slots from a catalog pack (or pick files), then Initialize custom.'}
      </Text>

      {(kws.initializedSummary || kws.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {kws.initializedSummary
              ? `Initialized: ${kws.initializedSummary}`
              : `Selected: ${
                  kws.selectedModelForInit
                    ? getModelDisplayName(kws.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {kws.catalogEntries.length === 0 &&
      !kws.loadingModels &&
      onOpenDownloads ? (
        <View style={styles.emptyCatalog}>
          <Text style={styles.sectionDescription}>
            No KWS packs on device. Download from Download Showcase
            (ModelCategory.Kws / kws-models).
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
          entries={kws.catalogEntries}
          selectedId={kws.selectedModelForInit}
          initializedId={kws.currentModelFolder}
          onSelect={kws.setSelectedModelForInit}
          loading={kws.loadingModels}
          disabled={busy}
          emptyMessage="No KWS models found."
        />
      )}

      {kws.initMode === 'custom' ? (
        <KwsCustomInitForm
          value={kws.customInitForm}
          onChange={kws.setCustomInitForm}
          selectedCatalogModelId={kws.selectedModelForInit}
          onFillFromSelectedModel={() => {
            kws.fillFromSelectedModel().catch(() => {});
          }}
          fillLoading={kws.customFillLoading}
          disabled={busy}
          fillHint={kws.customFillHint}
        />
      ) : null}

      <Text style={styles.smallLabel}>Tuning (applied at Init)</Text>
      <Text style={styles.smallLabel}>keywordsScore</Text>
      <TextInput
        style={styles.optionInput}
        value={kws.keywordsScore}
        onChangeText={kws.setKeywordsScore}
        keyboardType="decimal-pad"
        editable={!busy}
      />
      <Text style={styles.smallLabel}>keywordsThreshold</Text>
      <TextInput
        style={styles.optionInput}
        value={kws.keywordsThreshold}
        onChangeText={kws.setKeywordsThreshold}
        keyboardType="decimal-pad"
        editable={!busy}
      />
      <Text style={styles.smallLabel}>numTrailingBlanks</Text>
      <TextInput
        style={styles.optionInput}
        value={kws.numTrailingBlanks}
        onChangeText={kws.setNumTrailingBlanks}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Text style={styles.smallLabel}>maxActivePaths</Text>
      <TextInput
        style={styles.optionInput}
        value={kws.maxActivePaths}
        onChangeText={kws.setMaxActivePaths}
        keyboardType="number-pad"
        editable={!busy}
      />

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
          kws.initMode === 'custom' && !canInitCustom && styles.buttonDisabled,
        ]}
        onPress={() => {
          kws.applySelectedModel();
        }}
        disabled={
          busy ||
          (kws.initMode === 'auto'
            ? !kws.selectedModelForInit && !kws.currentModelFolder
            : !canInitCustom)
        }
      >
        <View style={styles.applyButtonContent}>
          {kws.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {kws.isEngineInitialized
              ? kws.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : kws.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Mid-run keyword edits: Stop → edit textarea → Rebuild → Spot again.
      </Text>

      {kws.initResult && !kws.error ? (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>{kws.initResult}</Text>
        </View>
      ) : null}

      {kws.error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorLabel}>Error:</Text>
          <Text style={styles.errorText}>{kws.error}</Text>
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
  optionInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#000000',
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
  hint: {
    marginTop: 8,
    fontSize: 13,
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
