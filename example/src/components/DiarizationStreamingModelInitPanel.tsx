import { useState } from 'react';
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
  CHUNK_SIZE_OPTIONS,
  type useDiarizationStreamingModelInit,
} from '../hooks/useDiarizationStreamingModelInit';
import {
  InitModeSelector,
  ModelFolderGrid,
  DiarizationStreamingCustomInitForm,
} from './modelInit';
import { styles as streamStyles } from '../screens/diarization-streaming/DiarizationStreamingScreen.styles';

type StreamingInit = ReturnType<typeof useDiarizationStreamingModelInit>;

type Props = {
  streaming: StreamingInit;
  sectionStart?: number;
  disabled?: boolean;
  onOpenDownloads?: () => void;
};

export function DiarizationStreamingModelInitPanel({
  streaming: s,
  sectionStart = 1,
  disabled = false,
  onOpenDownloads,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || s.loading || s.customFillLoading;
  const [tuningExpanded, setTuningExpanded] = useState(false);
  const hasAutoModels = s.catalogEntries.length > 0;
  const canInitCustom = s.customInitForm.fileSources.model != null;

  const isInitDisabled =
    busy ||
    (s.initMode === 'auto' &&
      (!s.selectedModelForInit || !hasAutoModels) &&
      !s.currentModelFolder) ||
    (s.initMode === 'custom' && !canInitCustom);

  return (
    <View style={streamStyles.card}>
      <Text style={streamStyles.cardTitle}>{n1}. Model & Engine Setup</Text>
      <Text style={streamStyles.cardSubtitle}>
        Configure NeMo Sortformer streaming diarization model and inference
        parameters. Init builds the engine; streaming runs reuse it until
        Rebuild or Release.
      </Text>

      <InitModeSelector
        value={s.initMode}
        onChange={(mode) => {
          s.setInitMode(mode);
          s.setError(null);
        }}
        disabled={busy}
      />

      {(s.initializedSummary ||
        s.currentModelFolder ||
        s.selectedModelForInit) && (
        <View style={panelStyles.currentModelContainer}>
          <Text style={panelStyles.currentModelText}>
            {s.initializedSummary
              ? `Initialized: ${s.initializedSummary}`
              : s.currentModelFolder
              ? `Loaded: ${getModelDisplayName(s.currentModelFolder)}`
              : `Selected: ${
                  s.selectedModelForInit
                    ? getModelDisplayName(s.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {s.initMode === 'auto' ? (
        <View style={streamStyles.marginTop10}>
          <ModelFolderGrid
            entries={s.catalogEntries}
            selectedId={s.selectedModelForInit}
            initializedId={s.engineInfo ? s.currentModelFolder : null}
            onSelect={s.setSelectedModelForInit}
            loading={s.loadingModels}
            disabled={busy}
            emptyMessage="No streaming diarization models found."
          />
          {!s.loadingModels &&
          s.catalogEntries.length === 0 &&
          onOpenDownloads ? (
            <View style={streamStyles.noModelsBanner}>
              <Text style={streamStyles.noModelsText}>
                No streaming diarization models found on device. Download
                Sortformer from the Download Showcase or configure custom paths.
              </Text>
              <TouchableOpacity
                style={streamStyles.downloadLinkButton}
                onPress={onOpenDownloads}
                disabled={busy}
              >
                <Ionicons
                  name="cloud-download-outline"
                  size={16}
                  color="#FFFFFF"
                />
                <Text style={streamStyles.downloadLinkText}>
                  Open Download Screen
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      ) : (
        <DiarizationStreamingCustomInitForm
          value={s.customInitForm}
          onChange={s.setCustomInitForm}
          selectedCatalogModelId={s.selectedModelForInit}
          onFillFromSelectedModel={() => {
            s.fillFromSelectedModel().catch(() => {});
          }}
          onPrepareScatteredTest={s.prepareScatteredTest}
          fillLoading={s.customFillLoading}
          fillHint={s.customFillHint}
          disabled={busy}
        />
      )}

      <Text style={[streamStyles.paramLabel, streamStyles.marginTop10]}>
        Streaming Latency Profile
      </Text>
      <View style={streamStyles.latencyRow}>
        {(
          [
            ['low', 'Low Latency (~1.0s) [Default]'],
            ['ultra_low', 'Ultra-Low (~0.3s)'],
            ['default', 'Standard (~10.0s)'],
            ['custom', 'Custom'],
          ] as const
        ).map(([profile, label]) => (
          <TouchableOpacity
            key={profile}
            style={[
              streamStyles.latencyChip,
              s.latencyProfile === profile && streamStyles.latencyChipActive,
            ]}
            onPress={() => s.setLatencyProfile(profile)}
            disabled={disabled}
          >
            <Text
              style={[
                streamStyles.latencyChipText,
                s.latencyProfile === profile &&
                  streamStyles.latencyChipTextActive,
              ]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={streamStyles.latencyHint}>
        {s.latencyProfile === 'low'
          ? '⚡ Real-time live mic feedback: updates every ~0.48s with a 1.04s lookahead window (chunkLen=6, rightContext=7).'
          : s.latencyProfile === 'ultra_low'
          ? '⚡⚡ Ultra-fast: updates every ~0.24s with a 0.32s lookahead window (chunkLen=3, rightContext=1).'
          : s.latencyProfile === 'default'
          ? '📁 High accuracy for audio files: updates every 9.92s with a 10.0s window (chunkLen=124, rightContext=1).'
          : `Custom window: chunkLen=${s.customChunkLen}, rightContext=${s.customRightContext}, fifoLen=${s.customFifoLen}.`}
      </Text>

      {s.latencyProfile === 'custom' ? (
        <View style={streamStyles.tuningSectionContent}>
          <View style={streamStyles.paramRow}>
            <Text style={streamStyles.paramLabel}>Chunk Len (80ms frames)</Text>
            <View style={streamStyles.paramControls}>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() => s.setCustomChunkLen((v) => Math.max(1, v - 1))}
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={streamStyles.paramValueBadge}>
                <Text style={streamStyles.paramValueText}>
                  {s.customChunkLen}
                </Text>
              </View>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() => s.setCustomChunkLen((v) => Math.min(250, v + 1))}
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={streamStyles.paramRow}>
            <Text style={streamStyles.paramLabel}>Right Context (frames)</Text>
            <View style={streamStyles.paramControls}>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() =>
                  s.setCustomRightContext((v) => Math.max(0, v - 1))
                }
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={streamStyles.paramValueBadge}>
                <Text style={streamStyles.paramValueText}>
                  {s.customRightContext}
                </Text>
              </View>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() =>
                  s.setCustomRightContext((v) => Math.min(50, v + 1))
                }
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={streamStyles.paramRow}>
            <Text style={streamStyles.paramLabel}>FIFO Size (frames)</Text>
            <View style={streamStyles.paramControls}>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() => s.setCustomFifoLen((v) => Math.max(10, v - 10))}
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={streamStyles.paramValueBadge}>
                <Text style={streamStyles.paramValueText}>
                  {s.customFifoLen}
                </Text>
              </View>
              <TouchableOpacity
                style={streamStyles.paramStepButton}
                onPress={() => s.setCustomFifoLen((v) => Math.min(300, v + 10))}
                disabled={disabled}
              >
                <Text style={streamStyles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={[streamStyles.paramRow, streamStyles.marginTop10]}
        onPress={() => setTuningExpanded((p) => !p)}
        disabled={disabled}
      >
        <Text style={[streamStyles.paramLabel, streamStyles.tuningToggleLabel]}>
          {tuningExpanded
            ? '▼ Hide Tuning Parameters'
            : '▶ Advanced Tuning Parameters'}
        </Text>
      </TouchableOpacity>

      {tuningExpanded ? (
        <View style={streamStyles.tuningSectionContent}>
          <TuningStepper
            label="Speech Onset Threshold"
            value={s.onset.toFixed(2)}
            onDec={() =>
              s.setOnset((v) =>
                Math.max(0.1, Math.round((v - 0.05) * 100) / 100)
              )
            }
            onInc={() =>
              s.setOnset((v) =>
                Math.min(0.9, Math.round((v + 0.05) * 100) / 100)
              )
            }
            disabled={disabled}
          />
          <TuningStepper
            label="Speech Offset Threshold"
            value={s.offset.toFixed(2)}
            onDec={() =>
              s.setOffset((v) =>
                Math.max(0.1, Math.round((v - 0.05) * 100) / 100)
              )
            }
            onInc={() =>
              s.setOffset((v) =>
                Math.min(0.9, Math.round((v + 0.05) * 100) / 100)
              )
            }
            disabled={disabled}
          />
          <TuningStepper
            label="Max Gap to Merge Turns"
            value={`${s.minDurationOff.toFixed(1)}s`}
            onDec={() =>
              s.setMinDurationOff((v) =>
                Math.max(0.0, Math.round((v - 0.1) * 10) / 10)
              )
            }
            onInc={() =>
              s.setMinDurationOff((v) =>
                Math.min(2.0, Math.round((v + 0.1) * 10) / 10)
              )
            }
            disabled={disabled}
          />
          <TuningStepper
            label="Min Turn Duration"
            value={`${s.minDurationOn.toFixed(2)}s`}
            onDec={() =>
              s.setMinDurationOn((v) =>
                Math.max(0.0, Math.round((v - 0.05) * 100) / 100)
              )
            }
            onInc={() =>
              s.setMinDurationOn((v) =>
                Math.min(1.0, Math.round((v + 0.05) * 100) / 100)
              )
            }
            disabled={disabled}
          />
          <View style={streamStyles.paramRow}>
            <Text style={streamStyles.paramLabel}>Drain Chunk Size</Text>
            <View style={streamStyles.paramControls}>
              {CHUNK_SIZE_OPTIONS.map((sz) => (
                <TouchableOpacity
                  key={sz}
                  style={[
                    streamStyles.toggleChip,
                    s.chunkSize === sz && streamStyles.toggleChipActive,
                    streamStyles.chunkChip,
                  ]}
                  onPress={() => s.setChunkSize(sz)}
                  disabled={disabled}
                >
                  <Text
                    style={[
                      streamStyles.toggleChipText,
                      s.chunkSize === sz && streamStyles.toggleChipTextActive,
                      streamStyles.chunkChipText,
                    ]}
                  >
                    {sz}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      ) : null}

      <View style={streamStyles.marginTop12}>
        <TouchableOpacity
          style={[
            streamStyles.primaryButton,
            isInitDisabled && streamStyles.buttonDisabled,
          ]}
          onPress={() => {
            s.applySelectedModel().catch(() => {});
          }}
          disabled={isInitDisabled}
        >
          {s.loading ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <>
              <Ionicons
                name="hardware-chip-outline"
                size={18}
                color="#FFFFFF"
              />
              <Text style={streamStyles.buttonText}>
                {s.initMode === 'auto' && !hasAutoModels
                  ? 'No Model Available'
                  : s.isEngineInitialized
                  ? 'Re-Initialize Engine'
                  : 'Initialize Diarization Engine'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[
          panelStyles.secondaryButton,
          (!s.isEngineInitialized || busy) && panelStyles.buttonDisabled,
        ]}
        onPress={() => {
          s.releaseEngine().catch(() => {});
        }}
        disabled={!s.isEngineInitialized || busy}
      >
        <Text style={panelStyles.secondaryButtonText}>Release engine</Text>
      </TouchableOpacity>

      {s.engineInfo ? (
        <View style={streamStyles.metaGrid}>
          <View style={streamStyles.metaBadge}>
            <Text style={streamStyles.metaBadgeLabel}>Sample Rate</Text>
            <Text style={streamStyles.metaBadgeValue}>
              {s.engineInfo.sampleRate} Hz
            </Text>
          </View>
          <View style={streamStyles.metaBadge}>
            <Text style={streamStyles.metaBadgeLabel}>Max Speakers</Text>
            <Text style={streamStyles.metaBadgeValue}>
              {s.engineInfo.maxSpeakers}
            </Text>
          </View>
          <View style={streamStyles.metaBadge}>
            <Text style={streamStyles.metaBadgeLabel}>Feed Window</Text>
            <Text style={streamStyles.metaBadgeValue}>
              {(s.engineInfo.feedSamples / s.engineInfo.sampleRate).toFixed(2)}s
            </Text>
          </View>
          <View style={streamStyles.metaBadge}>
            <Text style={streamStyles.metaBadgeLabel}>Step Stride</Text>
            <Text style={streamStyles.metaBadgeValue}>
              {(s.engineInfo.strideSamples / s.engineInfo.sampleRate).toFixed(
                2
              )}
              s
            </Text>
          </View>
          <View style={streamStyles.metaBadge}>
            <Text style={streamStyles.metaBadgeLabel}>Latency</Text>
            <Text style={streamStyles.metaBadgeValue}>
              {s.engineInfo.latencySeconds.toFixed(2)}s
            </Text>
          </View>
        </View>
      ) : null}

      {s.initResult && !s.error ? (
        <View style={panelStyles.resultContainer}>
          <Text style={panelStyles.resultText}>{s.initResult}</Text>
        </View>
      ) : null}

      {s.error ? (
        <View style={panelStyles.errorContainer}>
          <Text style={panelStyles.errorLabel}>Error:</Text>
          <Text style={panelStyles.errorText}>{s.error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function TuningStepper({
  label,
  value,
  onDec,
  onInc,
  disabled,
}: {
  label: string;
  value: string;
  onDec: () => void;
  onInc: () => void;
  disabled: boolean;
}) {
  return (
    <View style={streamStyles.paramRow}>
      <Text style={streamStyles.paramLabel}>{label}</Text>
      <View style={streamStyles.paramControls}>
        <TouchableOpacity
          style={streamStyles.paramStepButton}
          onPress={onDec}
          disabled={disabled}
        >
          <Text style={streamStyles.paramStepButtonText}>-</Text>
        </TouchableOpacity>
        <View style={streamStyles.paramValueBadge}>
          <Text style={streamStyles.paramValueText}>{value}</Text>
        </View>
        <TouchableOpacity
          style={streamStyles.paramStepButton}
          onPress={onInc}
          disabled={disabled}
        >
          <Text style={streamStyles.paramStepButtonText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const panelStyles = StyleSheet.create({
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
