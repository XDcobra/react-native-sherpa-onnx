import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { AudioOutputFormat } from 'react-native-sherpa-onnx/audio';
import type { FileDestination } from 'react-native-sherpa-onnx/fileio';
import { CODEC_ASSET_ENTRIES, type CodecAssetFormat } from '../../audioConfig';
import { describeFileSource } from '../../utils/fileSourceFromUri';
import {
  type AudioSourceChoice,
  type FileioInputChannelId,
  type FileioInputSource,
  type FileioOperation,
  type FileioSampleSelection,
  FILEIO_OUTPUT_FORMATS,
  listFileioInputChannels,
  pickFileioInputForChannel,
  resolveFileioInputSource,
  runFileioCopy,
  runFileioDecode,
  runFileioProbe,
} from './fileioActions';
import {
  buildFileioBatchMatrix,
  describeFileioActiveInputSummary,
  runFileioBatch,
} from './fileioBatch';

const FILE_DESTINATION_OPTIONS: {
  kind: FileDestination['kind'];
  label: string;
  hint: string;
}[] = [
  { kind: 'fs', label: 'fs', hint: 'Absolute filesystem path' },
  { kind: 'app', label: 'app', hint: 'App sandbox (base + relative path)' },
  {
    kind: 'contentUri',
    label: 'contentUri',
    hint: 'Single content:// document',
  },
  {
    kind: 'contentTree',
    label: 'contentTree',
    hint: 'SAF tree URI + filename + mime (Android)',
  },
  {
    kind: 'securityScoped',
    label: 'securityScoped',
    hint: 'Security-scoped URL (typically iOS)',
  },
];

const OPERATIONS: { id: FileioOperation; label: string }[] = [
  { id: 'probe', label: 'Probe' },
  { id: 'decode', label: 'Decode' },
  { id: 'encode', label: 'Encode' },
];

function formatLabel(format: AudioOutputFormat): string {
  return format.toUpperCase();
}

const DEFAULT_PAD_PACK = 'demo_codec_pack';

export default function FileIOScreen() {
  const [destinationKind, setDestinationKind] =
    useState<FileDestination['kind']>('fs');
  const [destMenuOpen, setDestMenuOpen] = useState(false);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);

  const [operation, setOperation] = useState<FileioOperation>('probe');
  const [sample, setSample] = useState<FileioSampleSelection>({
    kind: 'codec',
    format: 'wav',
  });
  const [inputChannel, setInputChannel] = useState<FileioInputChannelId>(
    Platform.OS === 'android' ? 'app_apkAsset' : 'app_appBundle'
  );
  const [manualPick, setManualPick] = useState<FileioInputSource | null>(null);
  const [padPackName, setPadPackName] = useState(DEFAULT_PAD_PACK);
  const [inputSource, setInputSource] = useState<FileioInputSource | null>(
    null
  );
  const [inputResolveError, setInputResolveError] = useState<string | null>(
    null
  );
  const [resolvingInput, setResolvingInput] = useState(false);

  const [audioSource, setAudioSource] =
    useState<AudioSourceChoice>('liveAudioBuffer');
  const [outputFormat, setOutputFormat] = useState<AudioOutputFormat>('wav');

  const [batchAllSamples, setBatchAllSamples] = useState(false);
  const [batchAllChannels, setBatchAllChannels] = useState(false);

  const [busy, setBusy] = useState(false);
  const [resultText, setResultText] = useState(
    'Choose a sample and FileSource channel, then run Probe, Decode, or Encode.'
  );

  const showResult = useCallback((text: string) => {
    console.log('[FileIO]', text);
    setResultText(text);
  }, []);

  const inputChannels = useMemo(() => listFileioInputChannels(), []);
  const activeChannelMeta = inputChannels.find((c) => c.id === inputChannel)!;

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      if (!activeChannelMeta.supported) {
        setInputSource(null);
        setInputResolveError(
          activeChannelMeta.unsupportedReason ?? 'Unsupported on this platform'
        );
        setResolvingInput(false);
        return;
      }

      if (!activeChannelMeta.automatic && !manualPick) {
        setInputSource(null);
        setInputResolveError(null);
        setResolvingInput(false);
        return;
      }

      setResolvingInput(true);
      setInputResolveError(null);
      try {
        const resolved = await resolveFileioInputSource({
          selection: sample,
          channelId: inputChannel,
          manualPick: manualPick ?? undefined,
          padPackName,
        });
        if (!cancelled) {
          setInputSource(resolved);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setInputSource(null);
          setInputResolveError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setResolvingInput(false);
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [
    sample,
    inputChannel,
    manualPick,
    padPackName,
    activeChannelMeta.supported,
    activeChannelMeta.automatic,
    activeChannelMeta.unsupportedReason,
  ]);

  const selectedDest = FILE_DESTINATION_OPTIONS.find(
    (o) => o.kind === destinationKind
  )!;

  const selectCodecSample = useCallback((format: CodecAssetFormat) => {
    setSample({ kind: 'codec', format });
  }, []);

  const selectLegacySample = useCallback(() => {
    setSample({ kind: 'legacy' });
  }, []);

  const selectInputChannel = useCallback(
    (id: FileioInputChannelId) => {
      setInputChannel(id);
      const meta = inputChannels.find((c) => c.id === id);
      if (meta?.automatic) {
        setManualPick(null);
      }
    },
    [inputChannels]
  );

  const pickInputForChannel = useCallback(async () => {
    if (inputChannel !== 'contentUri' && inputChannel !== 'securityScoped') {
      return;
    }
    try {
      const picked = await pickFileioInputForChannel(inputChannel);
      if (!picked) {
        return;
      }
      setManualPick(picked);
    } catch (e: unknown) {
      Alert.alert('Pick failed', e instanceof Error ? e.message : String(e));
    }
  }, [inputChannel]);

  const runPrimary = useCallback(async () => {
    const isBatch = batchAllSamples || batchAllChannels;

    if (batchAllSamples && !batchAllChannels && !activeChannelMeta.automatic) {
      Alert.alert(
        'Batch all samples',
        'Requires an automatic FileSource channel (not Pick). Turn on “Run all channels” or select an automatic channel.'
      );
      return;
    }

    if (!isBatch && (!inputSource || resolvingInput)) {
      Alert.alert(
        'Input not ready',
        inputResolveError ??
          (activeChannelMeta.automatic
            ? 'Still preparing input…'
            : 'Choose an audio file for this FileSource channel.')
      );
      return;
    }

    setBusy(true);
    try {
      if (isBatch) {
        const { samples, channelIds } = buildFileioBatchMatrix({
          batchAllSamples,
          batchAllChannels,
          currentSample: sample,
          currentChannelId: inputChannel,
        });
        const { text } = await runFileioBatch({
          operation,
          samples,
          channelIds,
          padPackName,
          destinationKind,
          audioSource,
          outputFormat,
        });
        showResult(text);
        if (operation === 'encode') {
          Alert.alert(
            'Batch encode finished',
            'See Result for per-item status.'
          );
        }
        return;
      }

      if (operation === 'probe') {
        const result = await runFileioProbe(inputSource!);
        if (result.status === 'success') {
          showResult(result.detail);
        } else {
          showResult(`Error\n\n${result.message}`);
        }
        return;
      }

      if (operation === 'decode') {
        const result = await runFileioDecode(inputSource!);
        if (result.status === 'success') {
          showResult(result.detail);
        } else {
          showResult(`Error\n\n${result.message}`);
        }
        return;
      }

      const copyResult = await runFileioCopy({
        destinationKind,
        audioSource,
        inputSource: inputSource!.fileSource,
        inputLabel: inputSource!.label,
        outputFormat,
      });

      if (copyResult.status === 'canceled') {
        showResult('Encode canceled.');
        return;
      }
      if (copyResult.status === 'success') {
        showResult(copyResult.detail);
        Alert.alert('Encode complete', copyResult.detail);
        return;
      }
      showResult(`Error\n\n${copyResult.message}`);
      Alert.alert('Encode failed', copyResult.message);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      showResult(`Error\n\n${message}`);
      Alert.alert('Failed', message);
    } finally {
      setBusy(false);
    }
  }, [
    showResult,
    operation,
    inputSource,
    resolvingInput,
    inputResolveError,
    activeChannelMeta.automatic,
    batchAllSamples,
    batchAllChannels,
    sample,
    inputChannel,
    padPackName,
    destinationKind,
    audioSource,
    outputFormat,
  ]);

  const isBatch = batchAllSamples || batchAllChannels;

  const activeInputBatchSummary = useMemo(() => {
    if (!isBatch) {
      return null;
    }
    return describeFileioActiveInputSummary({
      batchAllSamples,
      batchAllChannels,
      currentSample: sample,
      currentChannelId: inputChannel,
      operation,
    });
  }, [
    isBatch,
    batchAllSamples,
    batchAllChannels,
    sample,
    inputChannel,
    operation,
  ]);

  const primaryDisabled =
    busy || (!isBatch && (resolvingInput || !inputSource));

  const primaryLabel =
    operation === 'probe'
      ? busy
        ? isBatch
          ? 'Batch probing…'
          : 'Probing…'
        : isBatch
        ? 'Run batch probe'
        : 'Run probe'
      : operation === 'decode'
      ? busy
        ? isBatch
          ? 'Batch decoding…'
          : 'Decoding…'
        : isBatch
        ? 'Run batch decode'
        : 'Run decode'
      : busy
      ? isBatch
        ? 'Batch encoding…'
        : 'Encoding…'
      : isBatch
      ? 'Run batch encode'
      : 'Run encode';

  return (
    <SafeAreaView style={styles.root} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Sample file</Text>
          <Text style={styles.sectionHint}>
            Format chips pick which bundled test_codec file automatic channels
            use.
          </Text>
          <View style={styles.batchToggleRow}>
            <View style={styles.batchToggleTextCol}>
              <Text style={styles.batchToggleLabel}>Run all samples</Text>
              <Text style={styles.batchToggleHint}>
                On Run: every format chip (+ Legacy), current FileSource channel
              </Text>
            </View>
            <Switch
              value={batchAllSamples}
              onValueChange={setBatchAllSamples}
              accessibilityLabel="Run all sample formats on Run"
            />
          </View>
          <View
            style={[
              styles.chipRow,
              batchAllSamples && styles.selectionGroupDisabled,
            ]}
            pointerEvents={batchAllSamples ? 'none' : 'auto'}
          >
            {CODEC_ASSET_ENTRIES.map((entry) => {
              const active =
                sample.kind === 'codec' && sample.format === entry.format;
              return (
                <Pressable
                  key={entry.format}
                  style={[
                    styles.chip,
                    active && styles.chipActive,
                    batchAllSamples && styles.chipDisabled,
                  ]}
                  onPress={() => selectCodecSample(entry.format)}
                  disabled={batchAllSamples}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: active,
                    disabled: batchAllSamples,
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active && styles.chipTextActive,
                      batchAllSamples && styles.chipTextDisabled,
                    ]}
                  >
                    {entry.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              style={[
                styles.chip,
                sample.kind === 'legacy' && styles.chipActive,
                batchAllSamples && styles.chipDisabled,
              ]}
              onPress={selectLegacySample}
              disabled={batchAllSamples}
              accessibilityRole="button"
              accessibilityState={{ disabled: batchAllSamples }}
            >
              <Text
                style={[
                  styles.chipText,
                  sample.kind === 'legacy' && styles.chipTextActive,
                  batchAllSamples && styles.chipTextDisabled,
                ]}
              >
                Legacy
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>FileSource channel</Text>
          <Text style={styles.sectionHint}>
            How the sample is exposed as a FileSource. Copied channels stage the
            chip file first; pick channels need a file from the system.
          </Text>
          <View style={styles.batchToggleRow}>
            <View style={styles.batchToggleTextCol}>
              <Text style={styles.batchToggleLabel}>Run all channels</Text>
              <Text style={styles.batchToggleHint}>
                On Run: every automatic channel (excludes Pick), current sample
              </Text>
            </View>
            <Switch
              value={batchAllChannels}
              onValueChange={setBatchAllChannels}
              accessibilityLabel="Run all automatic FileSource channels on Run"
            />
          </View>
          <View
            pointerEvents={batchAllChannels ? 'none' : 'auto'}
            style={batchAllChannels ? styles.selectionGroupDisabled : undefined}
          >
            {inputChannels.map((ch) => {
              const active = ch.id === inputChannel;
              const disabled = !ch.supported || batchAllChannels;
              return (
                <Pressable
                  key={ch.id}
                  style={[
                    styles.channelRow,
                    active && styles.channelRowActive,
                    disabled && styles.channelRowDisabled,
                  ]}
                  onPress={() => {
                    if (!disabled) {
                      selectInputChannel(ch.id);
                    }
                  }}
                  disabled={disabled}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled }}
                >
                  <View style={styles.channelRowMain}>
                    <Text
                      style={[
                        styles.channelTitle,
                        active && styles.channelTitleActive,
                        disabled && styles.channelTitleDisabled,
                      ]}
                    >
                      {ch.title}
                    </Text>
                    <Text style={styles.channelHint} numberOfLines={2}>
                      {disabled ? ch.unsupportedReason : ch.hint}
                    </Text>
                  </View>
                  <View style={styles.channelBadges}>
                    <Text
                      style={[
                        styles.channelBadge,
                        ch.automatic
                          ? styles.channelBadgeAuto
                          : styles.channelBadgePick,
                      ]}
                    >
                      {ch.automatic ? 'Auto' : 'Pick'}
                    </Text>
                    {active && (
                      <Ionicons
                        name="checkmark-circle"
                        size={22}
                        color="#007AFF"
                      />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>

          {inputChannel === 'pad' && activeChannelMeta.supported && (
            <View style={styles.padField}>
              <Text style={styles.padLabel}>PAD pack name</Text>
              <TextInput
                style={[
                  styles.padInput,
                  batchAllChannels && styles.padInputDisabled,
                ]}
                value={padPackName}
                onChangeText={setPadPackName}
                placeholder={DEFAULT_PAD_PACK}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!batchAllChannels}
              />
            </View>
          )}

          {!activeChannelMeta.automatic && activeChannelMeta.supported && (
            <Pressable
              style={({ pressed }) => [
                styles.pickFileButton,
                pressed && !batchAllChannels && styles.pickFileButtonPressed,
                batchAllChannels && styles.pickFileButtonDisabled,
              ]}
              onPress={pickInputForChannel}
              disabled={batchAllChannels}
              accessibilityRole="button"
              accessibilityLabel="Choose audio file"
            >
              <Ionicons name="folder-open" size={22} color="#FFFFFF" />
              <Text style={styles.pickFileButtonText}>Choose audio file</Text>
            </Pressable>
          )}

          <View style={styles.inputCard}>
            <View style={styles.inputCardHeader}>
              <Text style={styles.inputCardTitle}>
                {isBatch ? 'Batch input' : 'Active FileSource'}
              </Text>
              {!isBatch && resolvingInput && (
                <ActivityIndicator size="small" color="#007AFF" />
              )}
            </View>
            {activeInputBatchSummary ? (
              <>
                <Text style={styles.inputCardLabel}>
                  {activeInputBatchSummary.label}
                </Text>
                <Text style={styles.inputCardPath} selectable>
                  {activeInputBatchSummary.detail}
                </Text>
              </>
            ) : inputSource ? (
              <>
                <Text style={styles.inputCardLabel}>{inputSource.label}</Text>
                <Text style={styles.inputCardPath} selectable>
                  {describeFileSource(inputSource.fileSource)}
                </Text>
              </>
            ) : (
              <Text style={styles.inputCardPlaceholder}>
                {inputResolveError ??
                  (activeChannelMeta.automatic
                    ? 'Preparing input…'
                    : 'Tap “Choose audio file” to set this channel.')}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Operation</Text>
          <View style={styles.segmented}>
            {OPERATIONS.map((op) => {
              const active = operation === op.id;
              return (
                <Pressable
                  key={op.id}
                  style={[styles.segment, active && styles.segmentActive]}
                  onPress={() => setOperation(op.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                    ]}
                  >
                    {op.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {operation === 'encode' && (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>FileDestination</Text>
              <Pressable
                style={styles.dropdownTrigger}
                onPress={() => setDestMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Choose FileDestination kind"
              >
                <View style={styles.dropdownTriggerText}>
                  <Text style={styles.dropdownKind}>{selectedDest.label}</Text>
                  <Text style={styles.dropdownHint} numberOfLines={1}>
                    {selectedDest.hint}
                  </Text>
                </View>
                <Ionicons name="chevron-down" size={20} color="#007AFF" />
              </Pressable>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Audio source (encode)</Text>
              <View style={styles.sourceCardsRow}>
                <Pressable
                  style={[
                    styles.sourceCard,
                    audioSource === 'liveAudioBuffer' &&
                      styles.sourceCardActive,
                  ]}
                  onPress={() => setAudioSource('liveAudioBuffer')}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: audioSource === 'liveAudioBuffer',
                  }}
                >
                  <Ionicons
                    name="pulse-outline"
                    size={22}
                    color={
                      audioSource === 'liveAudioBuffer' ? '#007AFF' : '#8E8E93'
                    }
                  />
                  <Text
                    style={[
                      styles.sourceCardTitle,
                      audioSource === 'liveAudioBuffer' &&
                        styles.sourceCardTitleActive,
                    ]}
                  >
                    Live
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.sourceCard,
                    audioSource === 'offlineAudioBuffer' &&
                      styles.sourceCardActive,
                  ]}
                  onPress={() => setAudioSource('offlineAudioBuffer')}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: audioSource === 'offlineAudioBuffer',
                  }}
                >
                  <Ionicons
                    name="layers-outline"
                    size={22}
                    color={
                      audioSource === 'offlineAudioBuffer'
                        ? '#007AFF'
                        : '#8E8E93'
                    }
                  />
                  <Text
                    style={[
                      styles.sourceCardTitle,
                      audioSource === 'offlineAudioBuffer' &&
                        styles.sourceCardTitleActive,
                    ]}
                  >
                    Offline
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.sourceCard,
                    audioSource === 'assetAudioFile' && styles.sourceCardActive,
                  ]}
                  onPress={() => setAudioSource('assetAudioFile')}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: audioSource === 'assetAudioFile',
                  }}
                >
                  <Ionicons
                    name="cube-outline"
                    size={22}
                    color={
                      audioSource === 'assetAudioFile' ? '#007AFF' : '#8E8E93'
                    }
                  />
                  <Text
                    style={[
                      styles.sourceCardTitle,
                      audioSource === 'assetAudioFile' &&
                        styles.sourceCardTitleActive,
                    ]}
                  >
                    File
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Output format</Text>
              <Pressable
                style={styles.dropdownTrigger}
                onPress={() => setFormatMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Choose output format"
              >
                <View style={styles.dropdownTriggerText}>
                  <Text style={styles.dropdownKind}>
                    {formatLabel(outputFormat)}
                  </Text>
                  <Text style={styles.dropdownHint}>
                    FFmpeg encode via saveAudioAsFile
                  </Text>
                </View>
                <Ionicons name="chevron-down" size={20} color="#007AFF" />
              </Pressable>
            </View>
          </>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Result</Text>
          <View style={styles.resultBox}>
            <Text style={styles.resultText} selectable>
              {resultText}
            </Text>
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={destMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDestMenuOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setDestMenuOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>FileDestination kind</Text>
            <ScrollView
              style={styles.modalList}
              keyboardShouldPersistTaps="handled"
            >
              {FILE_DESTINATION_OPTIONS.map((opt) => {
                const active = opt.kind === destinationKind;
                return (
                  <Pressable
                    key={opt.kind}
                    style={[styles.optionRow, active && styles.optionRowActive]}
                    onPress={() => {
                      setDestinationKind(opt.kind);
                      setDestMenuOpen(false);
                    }}
                  >
                    <View style={styles.optionTextCol}>
                      <Text
                        style={[
                          styles.optionKind,
                          active && styles.optionKindActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                      <Text style={styles.optionHint}>{opt.hint}</Text>
                    </View>
                    {active && (
                      <Ionicons name="checkmark" size={22} color="#007AFF" />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={formatMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFormatMenuOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setFormatMenuOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>Output format</Text>
            <ScrollView
              style={styles.modalList}
              keyboardShouldPersistTaps="handled"
            >
              {FILEIO_OUTPUT_FORMATS.map((fmt) => {
                const active = fmt === outputFormat;
                return (
                  <Pressable
                    key={fmt}
                    style={[styles.optionRow, active && styles.optionRowActive]}
                    onPress={() => {
                      setOutputFormat(fmt);
                      setFormatMenuOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.optionKind,
                        active && styles.optionKindActive,
                      ]}
                    >
                      {formatLabel(fmt)}
                    </Text>
                    {active && (
                      <Ionicons name="checkmark" size={22} color="#007AFF" />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            (pressed || primaryDisabled) && styles.primaryButtonPressed,
            primaryDisabled && styles.primaryButtonDisabled,
          ]}
          disabled={primaryDisabled}
          onPress={runPrimary}
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons
              name={
                operation === 'encode'
                  ? 'copy-outline'
                  : operation === 'decode'
                  ? 'download-outline'
                  : 'time-outline'
              }
              size={20}
              color="#FFFFFF"
            />
          )}
          <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  sectionHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 10,
    lineHeight: 18,
  },
  batchToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  batchToggleTextCol: {
    flex: 1,
    marginRight: 12,
  },
  batchToggleLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
  },
  batchToggleHint: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 2,
    lineHeight: 16,
  },
  selectionGroupDisabled: {
    opacity: 0.45,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#F2F2F7',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  chipActive: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.08)',
  },
  chipDisabled: {
    opacity: 0.55,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3A3A3C',
  },
  chipTextActive: {
    color: '#007AFF',
  },
  chipTextDisabled: {
    color: '#8E8E93',
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  channelRowActive: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.06)',
  },
  channelRowDisabled: {
    opacity: 0.45,
  },
  channelRowMain: {
    flex: 1,
    marginRight: 8,
  },
  channelTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
  },
  channelTitleActive: {
    color: '#007AFF',
  },
  channelTitleDisabled: {
    color: '#8E8E93',
  },
  channelHint: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 2,
    lineHeight: 16,
  },
  channelBadges: {
    alignItems: 'flex-end',
    gap: 4,
  },
  channelBadge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  channelBadgeAuto: {
    color: '#1C7C3A',
    backgroundColor: 'rgba(28, 124, 58, 0.12)',
  },
  channelBadgePick: {
    color: '#C45C00',
    backgroundColor: 'rgba(196, 92, 0, 0.12)',
  },
  padField: {
    marginBottom: 10,
  },
  padLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3A3A3C',
    marginBottom: 6,
  },
  padInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#000000',
  },
  padInputDisabled: {
    opacity: 0.45,
  },
  pickFileButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 12,
  },
  pickFileButtonPressed: {
    opacity: 0.88,
  },
  pickFileButtonDisabled: {
    opacity: 0.45,
  },
  pickFileButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  inputCard: {
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  inputCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  inputCardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  inputCardLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 6,
  },
  inputCardPath: {
    fontSize: 12,
    color: '#3A3A3C',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 18,
  },
  inputCardPlaceholder: {
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 18,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8E8E93',
  },
  segmentTextActive: {
    color: '#007AFF',
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  dropdownTriggerText: {
    flex: 1,
    marginRight: 8,
  },
  dropdownKind: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
  },
  dropdownHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 2,
  },
  sourceCardsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sourceCard: {
    flex: 1,
    minHeight: 72,
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceCardActive: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.06)',
  },
  sourceCardTitle: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '600',
    color: '#3A3A3C',
    textAlign: 'center',
  },
  sourceCardTitleActive: {
    color: '#007AFF',
  },
  resultBox: {
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 12,
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  resultText: {
    fontSize: 13,
    color: '#3A3A3C',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    maxHeight: '70%',
    paddingTop: 16,
    paddingBottom: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  modalList: {
    maxHeight: 360,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  optionRowActive: {
    backgroundColor: 'rgba(0, 122, 255, 0.08)',
  },
  optionTextCol: {
    flex: 1,
    marginRight: 8,
  },
  optionKind: {
    fontSize: 16,
    fontWeight: '500',
    color: '#000000',
  },
  optionKindActive: {
    color: '#007AFF',
  },
  optionHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 2,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C6C6C8',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryButtonDisabled: {
    opacity: 0.55,
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
