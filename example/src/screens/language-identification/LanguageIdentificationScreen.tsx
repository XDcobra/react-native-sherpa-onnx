import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY,
  type LanguageIdentificationPipelineHandle,
  type LanguageIdentificationResult,
  type SegmentedLanguageIdentificationResult,
} from 'react-native-sherpa-onnx/language-identification';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  ExampleAudioFileList,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { LanguageIdModelInitPanel } from '../../components/LanguageIdModelInitPanel';
import {
  formatLanguageIdInitError,
  useLanguageIdModelInit,
} from '../../hooks/useLanguageIdModelInit';
import {
  AUDIO_FILES,
  TEST_AUDIO_FILES,
  type AudioFileId,
} from '../../audioConfig';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import type { RootStackParamList } from '../../types/navigation';
import { LANG_COLORS, styles } from './LanguageIdentificationScreen.styles';

const LIVE_SAMPLE_RATE = 16000;

type ProcessingMode = 'batch' | 'liveOverload';
type LiveSourceMode = 'file' | 'mic';
type LiveFileSourceType = 'example' | 'own';

type LiveLogEntry = {
  id: string;
  kind: 'segment' | 'switch';
  text: string;
};

const LANG_AUDIO_FILES = AUDIO_FILES.filter(
  (file) =>
    file.language === 'en' ||
    file.language === 'zh' ||
    file.language === 'ja' ||
    file.language === 'ko' ||
    file.id === TEST_AUDIO_FILES.ZH_EN_1
);

const ZH_EN_META =
  LANG_AUDIO_FILES.find((file) => file.id === TEST_AUDIO_FILES.ZH_EN_1) ?? null;

const EN_1_META =
  LANG_AUDIO_FILES.find((file) => file.id === TEST_AUDIO_FILES.EN_1) ?? null;

/** Live overload always uses Auto segmentation → pin ZH↔EN code-switch clip. */
const LIVE_FAVORITE_AUDIO_IDS = ZH_EN_META
  ? ([TEST_AUDIO_FILES.ZH_EN_1] as const)
  : undefined;

const LIVE_SEG_DEFAULT: SegmentationControlConfig = {
  mode: 'auto',
  policy: { ...DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY },
};

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0.0s';
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function sortDistribution(
  distribution: Record<string, number>
): Array<{ lang: string; fraction: number }> {
  return Object.entries(distribution)
    .map(([lang, fraction]) => ({ lang, fraction }))
    .sort((a, b) => b.fraction - a.fraction);
}

function isSegmentedResult(
  result: LanguageIdentificationResult | SegmentedLanguageIdentificationResult
): result is SegmentedLanguageIdentificationResult {
  return (
    'dominantLanguage' in result &&
    'distribution' in result &&
    'segments' in result
  );
}

function colorForLang(lang: string, indexHint?: number): string {
  const hash = lang.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const index =
    typeof indexHint === 'number'
      ? indexHint
      : Math.abs(hash) % LANG_COLORS.length;
  return LANG_COLORS[index % LANG_COLORS.length]!;
}

export default function LanguageIdentificationScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );
  const languageId = useLanguageIdModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const [processingMode, setProcessingMode] = useState<ProcessingMode>('batch');
  const [identifying, setIdentifying] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runErrorSource, setRunErrorSource] = useState<
    'identify' | 'live' | null
  >(null);

  const [segBatchConfig, setSegBatchConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [segLiveConfig, setSegLiveConfig] =
    useState<SegmentationControlConfig>(LIVE_SEG_DEFAULT);

  const batchFavoriteAudioFileIds = useMemo(() => {
    if (segBatchConfig.mode === 'auto') {
      return ZH_EN_META ? ([TEST_AUDIO_FILES.ZH_EN_1] as const) : undefined;
    }
    return EN_1_META ? ([TEST_AUDIO_FILES.EN_1] as const) : undefined;
  }, [segBatchConfig.mode]);

  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [identifyProgress, setIdentifyProgress] = useState<{
    label: string;
    percent: number | null;
  } | null>(null);
  const [oneshotResult, setOneshotResult] =
    useState<LanguageIdentificationResult | null>(null);
  const [segmentedResult, setSegmentedResult] =
    useState<SegmentedLanguageIdentificationResult | null>(null);

  const [liveSourceMode, setLiveSourceMode] = useState<LiveSourceMode>('file');
  const [liveFileSourceType, setLiveFileSourceType] =
    useState<LiveFileSourceType>('example');
  const [selectedExampleAudioId, setSelectedExampleAudioId] =
    useState<AudioFileId>(TEST_AUDIO_FILES.ZH_EN_1);
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [liveRunState, setLiveRunState] = useState<
    'idle' | 'running' | 'stopping'
  >('idle');
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveCurrentLang, setLiveCurrentLang] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<LiveLogEntry[]>([]);

  const pipelineRef = useRef<LanguageIdentificationPipelineHandle | null>(null);
  const liveInRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextRef = useRef<LiveTextBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const cleanupLockRef = useRef(false);
  const liveRunEpochRef = useRef(0);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  const {
    engineRef,
    loading,
    isEngineInitialized,
    customFillLoading,
    releaseEngine,
  } = languageId;

  const engineReady = isEngineInitialized;
  const liveBusy = liveRunState === 'running' || liveRunState === 'stopping';
  const busy = loading || identifying || liveBusy || customFillLoading;

  const isZhEnPrepared =
    preparedInputBuffer != null &&
    ZH_EN_META != null &&
    preparedInputBuffer.sourceLabel === ZH_EN_META.name;

  const showZhEnOneshotWarn =
    processingMode === 'batch' &&
    segBatchConfig.mode === 'off' &&
    isZhEnPrepared;

  const clearResults = useCallback(() => {
    setOneshotResult(null);
    setSegmentedResult(null);
    setIdentifyProgress(null);
  }, []);

  const setRunErr = useCallback((source: 'identify' | 'live', e: unknown) => {
    setRunErrorSource(source);
    setRunError(formatLanguageIdInitError(e));
  }, []);

  const cleanupLiveRuntime = useCallback(async () => {
    if (cleanupLockRef.current) {
      return;
    }
    cleanupLockRef.current = true;
    try {
      try {
        ingestHandleRef.current?.cancel();
      } catch {
        // ignore
      }
      ingestHandleRef.current = null;

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore
      }

      try {
        await pipelineRef.current?.stop();
      } catch {
        // ignore
      }
      pipelineRef.current = null;

      const liveText = liveTextRef.current;
      liveTextRef.current = null;
      if (liveText) {
        await releasePipelineTextBuffer(liveText.bufferId).catch(() => {});
      }

      const liveIn = liveInRef.current;
      liveInRef.current = null;
      if (liveIn) {
        await releasePipelineAudioBuffer(liveIn.bufferId).catch(() => {});
      }
    } finally {
      cleanupLockRef.current = false;
    }
  }, []);

  onBeforeInitRef.current = async () => {
    await cleanupLiveRuntime();
    clearResults();
    setRunError(null);
    setRunErrorSource(null);
    setLiveStatus(null);
    setLiveCurrentLang(null);
    setLiveLog([]);
    setLiveRunState('idle');
  };

  useEffect(() => {
    return () => {
      cleanupLiveRuntime().catch(() => {});
    };
  }, [cleanupLiveRuntime]);

  const handleFree = useCallback(async () => {
    await cleanupLiveRuntime();
    await releaseEngine();
    clearResults();
    setLiveStatus(null);
    setLiveCurrentLang(null);
    setLiveLog([]);
    setLiveRunState('idle');
    setRunError(null);
    setRunErrorSource(null);
  }, [cleanupLiveRuntime, clearResults, releaseEngine]);

  const handleIdentifyBatch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !preparedInputBuffer) {
      setRunErr(
        'identify',
        'Initialize a model and prepare an offline audio buffer first.'
      );
      return;
    }

    setIdentifying(true);
    setRunError(null);
    setRunErrorSource(null);
    clearResults();
    setIdentifyProgress({ label: 'Identifying…', percent: null });

    try {
      const segOption = buildSegmentationOption(segBatchConfig);
      const useAuto =
        segOption != null &&
        segOption.mode === 'auto' &&
        segOption.policy != null;

      if (!useAuto) {
        const result = await engine.identify(preparedInputBuffer.bufferId);
        setOneshotResult(result);
        setIdentifyProgress(null);
        return;
      }

      const result = await engine.identify(preparedInputBuffer.bufferId, {
        segmentation: {
          mode: 'auto',
          policy: segOption!.policy,
        },
        onProgress: (progress) => {
          const percent =
            progress.totalSegments > 0
              ? Math.min(
                  99,
                  Math.round(
                    ((progress.currentSegment + 1) / progress.totalSegments) *
                      100
                  )
                )
              : Math.min(99, Math.round(progress.fraction * 100));
          setIdentifyProgress({
            label: `Segment ${progress.currentSegment + 1}/${
              progress.totalSegments
            }`,
            percent,
          });
        },
      });

      if (isSegmentedResult(result)) {
        setSegmentedResult(result);
      } else {
        setOneshotResult(result);
      }
      setIdentifyProgress({ label: 'Done', percent: 100 });
    } catch (identifyErr) {
      setRunErr('identify', identifyErr);
      setIdentifyProgress(null);
    } finally {
      setIdentifying(false);
    }
  }, [clearResults, engineRef, preparedInputBuffer, segBatchConfig, setRunErr]);

  const resolveLiveFileSource = useCallback((): FileSource => {
    if (liveFileSourceType === 'own') {
      if (!selectedFileUri) {
        throw new Error('Pick an audio file first.');
      }
      return toFileSource(selectedFileUri, selectedFileName ?? undefined);
    }
    const example =
      LANG_AUDIO_FILES.find((file) => file.id === selectedExampleAudioId) ??
      LANG_AUDIO_FILES[0];
    if (!example) {
      throw new Error('No example audio available.');
    }
    return fileSourceFromBundledPath(example.id);
  }, [
    liveFileSourceType,
    selectedExampleAudioId,
    selectedFileName,
    selectedFileUri,
  ]);

  const appendLiveLog = useCallback((entry: Omit<LiveLogEntry, 'id'>) => {
    setLiveLog((prev) => {
      const next = [
        ...prev,
        { ...entry, id: `${Date.now()}_${prev.length}_${Math.random()}` },
      ];
      return next.slice(-80);
    });
  }, []);

  const handleStartLive = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      setRunErr('live', 'Initialize a Language ID model first.');
      return;
    }

    const segOption = buildSegmentationOption(segLiveConfig);
    if (
      !segOption ||
      segOption.mode === 'off' ||
      !segOption.policy ||
      (segOption.policy.evaluator !== 'speech_energy_silence' &&
        segOption.policy.evaluator !== 'speech_vad_model')
    ) {
      setRunErr(
        'live',
        'Live overload requires speech_energy_silence or speech_vad_model segmentation (Auto).'
      );
      return;
    }

    setLiveRunState('running');
    const runEpoch = ++liveRunEpochRef.current;
    setRunError(null);
    setRunErrorSource(null);
    setLiveStatus(null);
    setLiveCurrentLang(null);
    setLiveLog([]);
    clearResults();

    await cleanupLiveRuntime();
    if (runEpoch !== liveRunEpochRef.current) {
      return;
    }

    try {
      const liveIn = await createEmptyLiveAudioBuffer({
        sampleRate: LIVE_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
      });
      liveInRef.current = liveIn;

      const liveText = await createLiveTextBuffer();
      liveTextRef.current = liveText;

      const pipeline = await engine.identify(liveIn, liveText, {
        segmentation: {
          mode: 'auto',
          policy: segOption.policy,
        },
        onSegment: (event) => {
          appendLiveLog({
            kind: 'segment',
            text: `#${event.segmentIndex} lang=${event.lang} (${event.durationMs}ms)`,
          });
          setLiveCurrentLang(event.lang);
        },
        onLanguageChanged: (event) => {
          const from = event.previousLang ?? '—';
          appendLiveLog({
            kind: 'switch',
            text: `${from} → ${event.currentLang}`,
          });
          setLiveCurrentLang(event.currentLang);
        },
      });
      pipelineRef.current = pipeline;
      if (runEpoch !== liveRunEpochRef.current) {
        return;
      }

      if (liveSourceMode === 'file') {
        setLiveStatus('Ingesting file…');
        const source = resolveLiveFileSource();
        const ingest = await ingestFileToLiveAudioBuffer(
          liveIn.bufferId,
          source,
          {
            targetSampleRateHz: LIVE_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
            backpressure: 'block',
          }
        );
        ingestHandleRef.current = ingest;
        await ingest.done;
        ingestHandleRef.current = null;
        if (runEpoch !== liveRunEpochRef.current) {
          return;
        }
        setLiveStatus('Draining language events…');
        await pipeline.completed;
        if (runEpoch !== liveRunEpochRef.current) {
          return;
        }
        pipelineRef.current = null;
        await pipeline.stop().catch(() => {});
        setLiveStatus('Done — file live overload complete.');
        setLiveRunState('idle');
        await cleanupLiveRuntime().catch(() => {});
      } else {
        setLiveStatus('Recording — speak, then Stop.');
        await startMicToLiveAudioBuffer(liveIn);
      }
    } catch (err) {
      if (runEpoch !== liveRunEpochRef.current) {
        return;
      }
      setRunErr('live', err);
      setLiveRunState('idle');
      setLiveStatus(null);
      await cleanupLiveRuntime().catch(() => {});
    }
  }, [
    appendLiveLog,
    cleanupLiveRuntime,
    clearResults,
    engineRef,
    liveSourceMode,
    resolveLiveFileSource,
    segLiveConfig,
    setRunErr,
  ]);

  const handleStopLive = useCallback(async () => {
    if (liveRunState === 'stopping' || liveRunState !== 'running') {
      return;
    }
    setLiveRunState('stopping');
    const wasMic = liveSourceMode === 'mic';
    liveRunEpochRef.current += 1;

    try {
      ingestHandleRef.current?.cancel();
      ingestHandleRef.current = null;
      await stopMicToLiveAudioBuffer().catch(() => {});

      const liveIn = liveInRef.current;
      if (liveIn) {
        await finalizeLiveAudioBuffer(liveIn.bufferId).catch(() => {});
      }

      const pipeline = pipelineRef.current;
      if (pipeline && wasMic) {
        setLiveStatus('Draining language events…');
        await pipeline.flush().catch(() => {});
        await pipeline.completed.catch(() => {});
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Stopped — mic session complete.');
      } else if (pipeline) {
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Cancelled.');
      }
    } finally {
      await cleanupLiveRuntime().catch(() => {});
      setLiveRunState('idle');
    }
  }, [cleanupLiveRuntime, liveRunState, liveSourceMode]);

  const pickFile = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (result) {
        const resolvedName =
          resolveAudioFileDisplayName(result.uri, result.name) ??
          result.name ??
          result.uri;
        setSelectedFileUri(result.uri);
        setSelectedFileName(resolvedName);
        setLiveFileSourceType('own');
      }
    } catch (pickErr) {
      const isPickCancel =
        (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
          pickErr
        ) ||
        (pickErr as { code?: string })?.code === 'DOCUMENT_PICKER_CANCELED' ||
        (pickErr as { name?: string })?.name === 'DocumentPickerCanceled';
      if (!isPickCancel) {
        setRunErr('live', pickErr);
      }
    }
  }, [setRunErr]);

  const copySegmentedJson = useCallback(() => {
    if (!segmentedResult) {
      return;
    }
    Clipboard.setString(JSON.stringify(segmentedResult, null, 2));
    Alert.alert('Copied', 'Segmented Language ID result JSON copied.');
  }, [segmentedResult]);

  const canRunBatch =
    processingMode === 'batch' &&
    engineReady &&
    !!preparedInputBuffer &&
    !identifying &&
    !liveBusy;

  const canRunLive =
    processingMode === 'liveOverload' &&
    engineReady &&
    !liveBusy &&
    (liveSourceMode === 'mic' ||
      (liveFileSourceType === 'example' && !!selectedExampleAudioId) ||
      (liveFileSourceType === 'own' && !!selectedFileUri));

  const oneshotRtf =
    oneshotResult && oneshotResult.audioDuration > 0
      ? oneshotResult.elapsedMs / (oneshotResult.audioDuration * 1000)
      : null;

  const distributionRows = segmentedResult
    ? sortDistribution(segmentedResult.distribution)
    : [];

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScreenIntroModal screenId="LanguageIdentification" />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="language" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Spoken Language ID</Text>
        </View>
        <Text style={styles.bodyText}>
          Whisper multilingual oneshot, segmented code-switching, and live
          overload — reuses STT Whisper packs.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Processing mode</Text>
          <View style={lpStyles.sourceToggle}>
            {(
              [
                ['batch', 'Offline batch'],
                ['liveOverload', 'Live overload'],
              ] as const
            ).map(([mode, label]) => (
              <TouchableOpacity
                key={mode}
                style={[
                  lpStyles.sourceToggleBtn,
                  processingMode === mode && lpStyles.sourceToggleBtnActive,
                ]}
                onPress={() => {
                  if (liveBusy || identifying) return;
                  setProcessingMode(mode);
                }}
                disabled={liveBusy || identifying}
              >
                <Text
                  style={[
                    lpStyles.sourceToggleText,
                    processingMode === mode && lpStyles.sourceToggleTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {engineReady ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              handleFree().catch(() => {});
            }}
            disabled={busy}
          >
            <Text style={styles.secondaryButtonText}>Release engine</Text>
          </TouchableOpacity>
        ) : null}

        <LanguageIdModelInitPanel
          languageId={languageId}
          disabled={identifying || liveBusy}
          onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
        />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Segmentation</Text>
          {processingMode === 'batch' ? (
            <>
              <View style={styles.apiTable}>
                <View style={styles.apiTableHeaderRow}>
                  <View style={styles.apiTableCellMode}>
                    <Text style={styles.apiTableHeaderText}>UI</Text>
                  </View>
                  <View style={styles.apiTableCellBody}>
                    <Text style={styles.apiTableHeaderText}>API</Text>
                  </View>
                </View>
                <View style={styles.apiTableRow}>
                  <View style={styles.apiTableCellMode}>
                    <Text style={styles.apiTableModeText}>Off</Text>
                  </View>
                  <View style={styles.apiTableCellBody}>
                    <Text style={styles.apiTableLabelText}>
                      Mode 1 · oneshot
                    </Text>
                    <Text style={styles.apiTableCodeText}>identify(audio)</Text>
                  </View>
                </View>
                <View style={[styles.apiTableRow, styles.apiTableRowLast]}>
                  <View style={styles.apiTableCellMode}>
                    <Text style={styles.apiTableModeText}>Auto</Text>
                  </View>
                  <View style={styles.apiTableCellBody}>
                    <Text style={styles.apiTableLabelText}>
                      Mode 2 · segmented
                    </Text>
                    <Text style={styles.apiTableCodeText}>
                      {"identify(audio, { segmentation: { mode: 'auto' } })"}
                    </Text>
                  </View>
                </View>
              </View>
              <SegmentationPolicyControls
                variant="speech-offline"
                value={segBatchConfig}
                onChange={setSegBatchConfig}
                disabled={identifying || liveBusy}
              />
            </>
          ) : (
            <>
              <Text style={styles.sectionHint}>
                Live overload requires Auto speech segmentation. Seeded from
                DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY (minSegmentMs 1500).
              </Text>
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segLiveConfig}
                onChange={setSegLiveConfig}
                disabled={liveBusy}
                disableOff
                disableManual
                allowedEvaluators={[
                  'speech_energy_silence',
                  'speech_vad_model',
                ]}
                offDisabledMessage="Live Language ID overload requires Auto segmentation with speech_energy_silence or speech_vad_model."
              />
            </>
          )}
        </View>

        {processingMode === 'batch' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input (offline)</Text>
            {showZhEnOneshotWarn ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnText}>
                  ZH↔EN meeting with segmentation Off runs oneshot: Whisper
                  truncates ~30s and you lose the code-switch timeline. Switch
                  segmentation to Auto for Mode 2.
                </Text>
              </View>
            ) : null}

            <OfflineAudioBufferWidget
              ref={offlineWidgetRef}
              audioFiles={LANG_AUDIO_FILES}
              favoriteAudioFileIds={batchFavoriteAudioFileIds}
              visible={engineReady}
              disabled={!engineReady || identifying || liveBusy}
              onBufferReady={(info) => {
                setPreparedInputBuffer(info);
                clearResults();
              }}
              onBufferReleased={() => {
                setPreparedInputBuffer(null);
                clearResults();
              }}
            />

            {identifyProgress ? (
              <View style={styles.progressBox}>
                <Text style={styles.progressLabel}>
                  {identifyProgress.label}
                  {identifyProgress.percent != null
                    ? ` · ${identifyProgress.percent}%`
                    : ''}
                </Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      identifyProgress.percent == null
                        ? styles.progressIndeterminate
                        : { width: `${identifyProgress.percent}%` },
                    ]}
                  />
                </View>
              </View>
            ) : null}

            <TouchableOpacity
              style={[
                styles.primaryButton,
                !canRunBatch && styles.buttonDisabled,
              ]}
              onPress={() => {
                handleIdentifyBatch().catch(() => {});
              }}
              disabled={!canRunBatch}
            >
              {identifying ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>Identify language</Text>
              )}
            </TouchableOpacity>

            {runError && runErrorSource === 'identify' ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{runError}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input (live)</Text>
            <View style={lpStyles.sourceToggle}>
              {(['file', 'mic'] as LiveSourceMode[]).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={[
                    lpStyles.sourceToggleBtn,
                    liveSourceMode === mode && lpStyles.sourceToggleBtnActive,
                  ]}
                  onPress={() => {
                    if (liveBusy) return;
                    setLiveSourceMode(mode);
                  }}
                  disabled={liveBusy}
                >
                  <Text
                    style={[
                      lpStyles.sourceToggleText,
                      liveSourceMode === mode &&
                        lpStyles.sourceToggleTextActive,
                    ]}
                  >
                    {mode === 'mic' ? 'Microphone' : 'File'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {liveSourceMode === 'file' ? (
              <>
                <View style={lpStyles.sourceToggle}>
                  {(
                    [
                      ['example', 'Example'],
                      ['own', 'Own file'],
                    ] as const
                  ).map(([mode, label]) => (
                    <TouchableOpacity
                      key={mode}
                      style={[
                        lpStyles.sourceToggleBtn,
                        liveFileSourceType === mode &&
                          lpStyles.sourceToggleBtnActive,
                      ]}
                      onPress={() => {
                        if (liveBusy) return;
                        setLiveFileSourceType(mode);
                      }}
                      disabled={liveBusy}
                    >
                      <Text
                        style={[
                          lpStyles.sourceToggleText,
                          liveFileSourceType === mode &&
                            lpStyles.sourceToggleTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {liveFileSourceType === 'example' ? (
                  <ExampleAudioFileList
                    audioFiles={LANG_AUDIO_FILES}
                    favoriteAudioFileIds={LIVE_FAVORITE_AUDIO_IDS}
                    selectedId={selectedExampleAudioId}
                    onSelect={(audioFile) => {
                      setSelectedExampleAudioId(audioFile.id);
                      setLiveFileSourceType('example');
                    }}
                    disabled={liveBusy}
                  />
                ) : !selectedFileUri ? (
                  <TouchableOpacity
                    style={lpStyles.optionButton}
                    onPress={() => {
                      pickFile().catch(() => {});
                    }}
                    disabled={liveBusy}
                  >
                    <Text style={lpStyles.optionButtonText}>
                      Pick audio file…
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.selectedFileRow}>
                    <View style={styles.selectedFileInfo}>
                      <Text style={styles.sectionHint}>Selected file</Text>
                      <Text style={styles.bodyText} numberOfLines={2}>
                        {selectedFileName ?? selectedFileUri}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        if (liveBusy) return;
                        setSelectedFileUri(null);
                        setSelectedFileName(null);
                      }}
                      disabled={liveBusy}
                    >
                      <Text style={styles.errorText}>Clear</Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.sectionHint}>
                Microphone audio is labeled in real time as speech segments
                commit (≥ ~1.5s). Stop when finished.
              </Text>
            )}

            {liveCurrentLang ? (
              <View style={styles.langHero}>
                <View style={styles.langChip}>
                  <Text style={styles.langChipText}>
                    {liveCurrentLang.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.metaText}>Current language</Text>
              </View>
            ) : null}

            {liveStatus ? (
              <Text style={styles.bodyText}>{liveStatus}</Text>
            ) : null}

            {liveRunState === 'idle' &&
            liveStatus != null &&
            liveLog.length === 0 &&
            !liveCurrentLang ? (
              <Text style={styles.sectionHint}>
                No language segments were committed. Speech spans shorter than ~
                1.5s are skipped; try a longer clip or speak longer turns.
              </Text>
            ) : null}

            {liveLog.length > 0 ? (
              <View style={styles.liveLogBox}>
                <ScrollView nestedScrollEnabled>
                  {liveLog.map((entry) => (
                    <Text
                      key={entry.id}
                      style={[
                        styles.logLine,
                        entry.kind === 'switch' && styles.logSwitch,
                      ]}
                    >
                      {entry.text}
                    </Text>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {liveRunState === 'idle' ? (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  !canRunLive && styles.buttonDisabled,
                ]}
                onPress={() => {
                  handleStartLive().catch(() => {});
                }}
                disabled={!canRunLive}
              >
                <Text style={styles.primaryButtonText}>Start live ID</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.dangerButton, styles.flexButton]}
                onPress={() => {
                  handleStopLive().catch(() => {});
                }}
                disabled={liveRunState === 'stopping'}
              >
                {liveRunState === 'stopping' ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.dangerButtonText}>Stop</Text>
                )}
              </TouchableOpacity>
            )}

            {runError && runErrorSource === 'live' ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{runError}</Text>
              </View>
            ) : null}
          </View>
        )}

        {oneshotResult ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Oneshot result</Text>
            <View style={styles.langHero}>
              <View style={styles.langChip}>
                <Text style={styles.langChipText}>
                  {oneshotResult.lang.toUpperCase()}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaText}>
                  Audio {formatSeconds(oneshotResult.audioDuration)}
                </Text>
                <Text style={styles.metaText}>
                  {oneshotResult.elapsedMs.toFixed(0)} ms
                </Text>
                {oneshotRtf != null ? (
                  <Text style={styles.metaText}>
                    RTF {oneshotRtf.toFixed(2)}×
                  </Text>
                ) : null}
              </View>
            </View>
            {oneshotResult.audioDuration > 30 ? (
              <View style={styles.warnBox}>
                <Text style={styles.warnText}>
                  Audio duration {formatSeconds(oneshotResult.audioDuration)}{' '}
                  exceeds Whisper&apos;s ~30s oneshot window — later speech was
                  likely ignored. Use Auto segmentation for long files.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {segmentedResult ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Segmented result</Text>
            <View style={styles.langHero}>
              <View style={styles.langChip}>
                <Text style={styles.langChipText}>
                  {segmentedResult.dominantLanguage.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.metaText}>
                Dominant · {segmentedResult.totalSegments} segment(s) ·{' '}
                {segmentedResult.processingTimeMs.toFixed(0)} ms
              </Text>
            </View>

            <Text style={styles.cardTitle}>Distribution</Text>
            {distributionRows.map((row, index) => (
              <View key={row.lang} style={styles.distRow}>
                <Text style={styles.distLabel}>{row.lang}</Text>
                <View style={styles.distTrack}>
                  <View
                    style={[
                      styles.distFill,
                      {
                        width: `${Math.max(
                          2,
                          Math.round(row.fraction * 100)
                        )}%`,
                        backgroundColor: colorForLang(row.lang, index),
                      },
                    ]}
                  />
                </View>
                <Text style={styles.distPct}>
                  {(row.fraction * 100).toFixed(0)}%
                </Text>
              </View>
            ))}

            {segmentedResult.switches.length > 0 ? (
              <>
                <Text style={styles.cardTitle}>Switches</Text>
                {segmentedResult.switches.map((sw, index) => (
                  <View
                    key={`${sw.segmentIndex}_${sw.timestamp}_${index}`}
                    style={styles.switchRow}
                  >
                    <Text style={styles.switchTime}>
                      {formatSeconds(sw.timestamp)}
                    </Text>
                    <Text style={styles.switchText}>
                      {(sw.from ?? '—').toUpperCase()} → {sw.to.toUpperCase()}
                    </Text>
                  </View>
                ))}
              </>
            ) : (
              <Text style={styles.sectionHint}>
                No language switches detected across segments.
              </Text>
            )}

            <Text style={styles.cardTitle}>Segments</Text>
            {segmentedResult.segments.map((seg) => (
              <View key={seg.segmentIndex} style={styles.segmentRow}>
                <View style={styles.segmentChip}>
                  <Text style={styles.segmentChipText}>
                    {seg.lang.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.segmentMeta}>
                  #{seg.segmentIndex} · {formatSeconds(seg.startTime)}–
                  {formatSeconds(seg.endTime)} · {seg.durationMs}ms
                </Text>
              </View>
            ))}

            <TouchableOpacity
              style={styles.copyBtn}
              onPress={copySegmentedJson}
            >
              <Text style={styles.copyBtnText}>Copy JSON</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
