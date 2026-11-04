import type { ReactNode } from 'react';
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
  AlignmentCustomInitForm,
  InitModeSelector,
  ModelFolderGrid,
  SttCustomInitForm,
} from './modelInit';
import type { UseGenerateTimestampModelInitReturn } from '../hooks/useGenerateTimestampModelInit';
import { styles as screenStyles } from '../screens/generate-timestamp/GenerateTimestampScreen.styles';

type Props = {
  init: UseGenerateTimestampModelInitReturn;
  stepLabels: {
    alignment: string | null;
    vad: string | null;
    stt: string | null;
  };
  requiresAlignmentModel: boolean;
  requiresVadModel: boolean;
  requiresSttModel: boolean;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

function ModelSection(props: {
  stepLabel: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View style={screenStyles.section}>
      <View style={screenStyles.sectionHeader}>
        <View style={screenStyles.stepBadge}>
          <Text style={screenStyles.stepBadgeText}>{props.stepLabel}</Text>
        </View>
        <Text style={screenStyles.sectionTitle}>{props.title}</Text>
        <Text style={screenStyles.sectionDescription}>{props.description}</Text>
      </View>
      {props.children}
    </View>
  );
}

export function GenerateTimestampModelInitPanel({
  init,
  stepLabels,
  requiresAlignmentModel,
  requiresVadModel,
  requiresSttModel,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const { alignment: aln, vad, stt } = init;

  const alignmentBusy =
    disabled || aln.loading || aln.customFillLoading || aln.loadingModels;
  const vadBusy = disabled || vad.loading || vad.loadingModels;
  const sttBusy =
    disabled || stt.loading || stt.customFillLoading || stt.loadingModels;

  return (
    <>
      {requiresAlignmentModel && stepLabels.alignment ? (
        <ModelSection
          stepLabel={stepLabels.alignment}
          title="Prepare wav2vec2 alignment model"
          description="Plain accurate and anchor-constrained accurate modes require wav2vec2. Auto: detect from catalog. Custom: explicit ONNX per accurate call."
        >
          <InitModeSelector
            value={aln.initMode}
            onChange={(mode) => {
              aln.setInitMode(mode);
              aln.setError(null);
            }}
            disabled={alignmentBusy}
          />

          {aln.initializedSummary ? (
            <View style={screenStyles.currentModelContainer}>
              <Text style={screenStyles.currentModelText}>
                Ready: {aln.initializedSummary}
              </Text>
              {aln.initMode === 'auto' && aln.preparedModelPath ? (
                <Text style={screenStyles.currentModelMetaText}>
                  {aln.preparedModelType ?? 'unknown'} · {aln.preparedModelPath}
                </Text>
              ) : null}
            </View>
          ) : null}

          {aln.catalogEntries.length === 0 &&
          !aln.loadingModels &&
          onOpenDownloads ? (
            <View style={styles.emptyCatalog}>
              <TouchableOpacity
                style={styles.downloadButton}
                onPress={onOpenDownloads}
                disabled={alignmentBusy}
              >
                <Ionicons
                  name="cloud-download-outline"
                  size={16}
                  color="#FFFFFF"
                />
                <Text style={styles.downloadButtonText}>
                  Open Download Screen
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ModelFolderGrid
              entries={aln.catalogEntries}
              selectedId={aln.selectedModelForInit}
              initializedId={aln.currentModelFolder}
              onSelect={(id) => {
                aln.setSelectedModelForInit(id);
                aln.setError(null);
              }}
              loading={aln.loadingModels}
              disabled={alignmentBusy}
              emptyMessage="No alignment models found. Add wav2vec2 under assets, PAD, or downloads (category: alignment)."
            />
          )}

          {aln.initMode === 'custom' ? (
            <AlignmentCustomInitForm
              value={aln.customInitForm}
              onChange={aln.setCustomInitForm}
              selectedCatalogModelId={aln.selectedModelForInit}
              onFillFromSelectedModel={() => {
                aln.fillFromSelectedModel().catch(() => {});
              }}
              onPrepareScatteredTest={aln.prepareScatteredTest}
              fillLoading={aln.customFillLoading}
              disabled={alignmentBusy}
              fillHint={aln.customFillHint}
            />
          ) : null}

          <Pressable
            style={[
              screenStyles.button,
              screenStyles.applyButton,
              (alignmentBusy ||
                (aln.initMode === 'auto' && !aln.selectedModelForInit) ||
                (aln.initMode === 'custom' &&
                  !aln.customInitForm.fileSources.model)) &&
                screenStyles.buttonDisabled,
            ]}
            onPress={() => {
              aln.applySelectedModel().catch(() => {});
            }}
            disabled={
              alignmentBusy ||
              (aln.initMode === 'auto' && !aln.selectedModelForInit) ||
              (aln.initMode === 'custom' &&
                !aln.customInitForm.fileSources.model)
            }
          >
            {aln.loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={screenStyles.buttonText}>
                {aln.initMode === 'auto'
                  ? 'Use alignment model'
                  : 'Initialize custom alignment'}
              </Text>
            )}
          </Pressable>

          {aln.error ? (
            <Text style={styles.inlineError}>{aln.error}</Text>
          ) : null}
        </ModelSection>
      ) : null}

      {requiresVadModel && stepLabels.vad ? (
        <ModelSection
          stepLabel={stepLabels.vad}
          title="Prepare VAD anchors"
          description="Offline speech anchors via segmentOfflineBuffer and speech_vad_model. Same detect path as other offline VAD segmentation."
        >
          {vad.initializedSummary ? (
            <View style={screenStyles.currentModelContainer}>
              <Text style={screenStyles.currentModelText}>
                Ready: {vad.initializedSummary}
              </Text>
              {vad.preparedModelPath ? (
                <Text style={screenStyles.currentModelMetaText}>
                  {vad.preparedModelType ?? 'unknown'} · {vad.preparedModelPath}
                </Text>
              ) : null}
            </View>
          ) : null}

          <ModelFolderGrid
            entries={vad.catalogEntries}
            selectedId={vad.selectedModelForInit}
            initializedId={vad.currentModelFolder}
            onSelect={(id) => {
              vad.setSelectedModelForInit(id);
              vad.setError(null);
            }}
            loading={vad.loadingModels}
            disabled={vadBusy}
            emptyMessage="No VAD models found. Add one under assets, PAD, or downloads (category: vad)."
          />

          <Pressable
            style={[
              screenStyles.button,
              screenStyles.applyButton,
              (vadBusy || !vad.selectedModelForInit) &&
                screenStyles.buttonDisabled,
            ]}
            onPress={() => {
              vad.applySelectedModel().catch(() => {});
            }}
            disabled={vadBusy || !vad.selectedModelForInit}
          >
            {vad.loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={screenStyles.buttonText}>Use VAD model</Text>
            )}
          </Pressable>

          {vad.error ? (
            <Text style={styles.inlineError}>{vad.error}</Text>
          ) : null}
        </ModelSection>
      ) : null}

      {requiresSttModel && stepLabels.stt ? (
        <ModelSection
          stepLabel={stepLabels.stt}
          title="Prepare STT hypothesis model"
          description="asr_mediated requires hypothesis buffer H with token timestamps. Init builds STT once; run reuses the cached engine."
        >
          <InitModeSelector
            value={stt.initMode}
            onChange={stt.setInitMode}
            disabled={sttBusy}
          />

          {(stt.initializedSummary || stt.selectedModelForInit) && (
            <View style={screenStyles.currentModelContainer}>
              <Text style={screenStyles.currentModelText}>
                {stt.initializedSummary
                  ? `Initialized: ${stt.initializedSummary}`
                  : `Selected: ${
                      stt.selectedModelForInit
                        ? getModelDisplayName(stt.selectedModelForInit)
                        : ''
                    }`}
              </Text>
            </View>
          )}

          <ModelFolderGrid
            entries={stt.catalogEntries}
            selectedId={stt.selectedModelForInit}
            initializedId={stt.currentModelFolder}
            onSelect={stt.setSelectedModelForInit}
            loading={stt.loadingModels}
            disabled={sttBusy}
            emptyMessage="No STT models found. Add one under assets, PAD, or downloads (category: stt)."
          />

          {stt.initMode === 'custom' ? (
            <SttCustomInitForm
              value={stt.customInitForm}
              onChange={stt.setCustomInitForm}
              selectedCatalogModelId={stt.selectedModelForInit}
              onFillFromSelectedModel={() => {
                stt.fillFromSelectedModel().catch(() => {});
              }}
              onPrepareScatteredTest={stt.prepareScatteredTest}
              fillLoading={stt.customFillLoading}
              disabled={sttBusy}
              fillHint={stt.customFillHint}
            />
          ) : null}

          <Pressable
            style={[
              screenStyles.button,
              screenStyles.applyButton,
              sttBusy && screenStyles.buttonDisabled,
            ]}
            onPress={() => {
              stt.applySelectedModel().catch(() => {});
            }}
            disabled={sttBusy}
          >
            {stt.loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={screenStyles.buttonText}>Use STT model</Text>
            )}
          </Pressable>

          {stt.error ? (
            <Text style={styles.inlineError}>{stt.error}</Text>
          ) : null}
        </ModelSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  emptyCatalog: {
    marginBottom: 12,
  },
  downloadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  downloadButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  inlineError: {
    marginTop: 8,
    fontSize: 13,
    color: '#C62828',
  },
});
