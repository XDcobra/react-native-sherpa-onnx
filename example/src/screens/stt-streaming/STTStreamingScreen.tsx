import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createStreamingSTT,
  detectSttModel,
  assertStreamingSttCustomConfig,
  type LiveSttEngine,
  type StreamingSttCustomConfig,
  type SttPipelineHandle,
} from 'react-native-sherpa-onnx/stt';
import {
  EngineModeModelSelector,
  type EngineMode,
} from '../../components/EngineModeModelSelector';
import {
  createEmptyLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  InitModeSelector,
  StreamingSttCustomInitForm,
  type ModelInitMode,
  type StreamingSttCustomInitFormState,
} from '../../components/modelInit';
import { fillStreamingCustomConfigFromFolder } from '../../utils/streamingCustomInitFill';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import {
  getAssetModelPath,
  getFileModelPath,
  toDetectSource,
} from '../../modelConfig';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import {
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';

const STT_INPUT_SAMPLE_RATE = 16000;
const PAD_PACK_NAME = 'sherpa_models';

const DEFAULT_STREAMING_CUSTOM_INIT: StreamingSttCustomInitFormState = {
  modelType: 'transducer',
  fileSources: {},
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: string; code?: string };
    if (maybe.message && maybe.code) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) return maybe.message;
  }
  return 'Unknown error';
}

type StreamingState = 'idle' | 'starting' | 'running' | 'stopping';
type SourceMode = 'mic' | 'file';

export default function STTStreamingScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /** File-backed STT locations: downloads, FS scan, and asset-pack pad (same union as Live Pipeline Showcase). */
  const [sttFileBackedIds, setSttFileBackedIds] = useState<string[]>([]);
  const [sttPadIds, setSttPadIds] = useState<string[]>([]);
  const [sttPadPath, setSttPadPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [engineMode, setEngineMode] = useState<EngineMode>('streaming');
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<StreamingSttCustomInitFormState>(DEFAULT_STREAMING_CUSTOM_INIT);
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [streamingModelIds, setStreamingModelIds] = useState<Set<string>>(
    new Set()
  );
  const [offlineModelIds, setOfflineModelIds] = useState<Set<string>>(
    new Set()
  );
  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [status, setStatus] = useState(
    'Select a model, choose microphone or file input, then start streaming.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [committedTranscript, setCommittedTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');

  const engineRef = useRef<LiveSttEngine | null>(null);
  const pipelineRef = useRef<SttPipelineHandle | null>(null);
  const liveAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextBufferRef = useRef<LiveTextBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupLockRef = useRef(false);

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (sttPadIds.includes(modelFolder)) {
        return sttPadPath
          ? getFileModelPath(modelFolder, ModelCategory.Stt, sttPadPath)
          : getFileModelPath(modelFolder, ModelCategory.Stt);
      }
      if (sttFileBackedIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Stt);
      }
      return getAssetModelPath(modelFolder);
    },
    [sttFileBackedIds, sttPadIds, sttPadPath]
  );

  // Auto-enforce segmentation when switching to Live Overload mode
  useEffect(() => {
    if (engineMode === 'offline') {
      setSegConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: {
              evaluator: 'speech_energy_silence',
              maxSegmentMs: 10000,
            },
          };
        }
        return prev;
      });
    }
  }, [engineMode]);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
      const fallbackPath = `${DocumentDirectoryPath}/models`;
      const padPath = padPathFromNative ?? fallbackPath;

      const allAsset = await listAssetModels();
      const assetSttIds = allAsset
        .filter((m) => m.hint === 'stt')
        .map((m) => m.folder);

      const sttDl = await listDownloadedModels(ModelCategory.Stt).then((r) =>
        r.map((m) => m.id)
      );

      const padResults = await listModelsAtPath(padPath).catch(() => []);
      const padSttIds = padResults
        .filter((m) => m.hint === 'stt')
        .map((m) => m.folder);

      const sttFilePath = `${DocumentDirectoryPath}/sherpa-onnx/models/${ModelCategory.Stt}`;
      const sttFs = await listModelsAtPath(sttFilePath).catch(() => []);
      const sttFsIds = sttFs.map((m) => m.folder);

      const candidateModels = [
        ...padSttIds,
        ...assetSttIds.filter((f) => !padSttIds.includes(f)),
        ...sttDl.filter(
          (f) => !padSttIds.includes(f) && !assetSttIds.includes(f)
        ),
        ...sttFsIds.filter(
          (f) =>
            !padSttIds.includes(f) &&
            !assetSttIds.includes(f) &&
            !sttDl.includes(f)
        ),
      ];

      const sttPadSet = new Set(padSttIds);
      const sttAssetSet = new Set(assetSttIds);
      const fileBackedUnion = [
        ...new Set([...sttDl, ...sttFsIds, ...padSttIds]),
      ];

      const sttDetections = await Promise.all(
        candidateModels.map(async (modelFolder) => {
          try {
            const modelPath = sttPadSet.has(modelFolder)
              ? getFileModelPath(modelFolder, ModelCategory.Stt, padPath)
              : sttAssetSet.has(modelFolder)
              ? getAssetModelPath(modelFolder)
              : getFileModelPath(modelFolder, ModelCategory.Stt);
            const detection = await detectSttModel(
              await toDetectSource(modelPath),
              {
                modelType: 'auto',
              }
            );
            if (!detection.success) {
              return { folder: modelFolder, streaming: false, offline: false };
            }
            return {
              folder: modelFolder,
              streaming: detection.isStreaming,
              offline: !detection.isStreaming,
            };
          } catch {
            return { folder: modelFolder, streaming: false, offline: false };
          }
        })
      );

      const streamingIds = new Set(
        sttDetections.filter((r) => r.streaming).map((r) => r.folder)
      );
      const offlineIds = new Set(
        sttDetections.filter((r) => r.offline).map((r) => r.folder)
      );

      const available = candidateModels.filter(
        (folder) => streamingIds.has(folder) || offlineIds.has(folder)
      );

      setAvailableModels(available);
      setStreamingModelIds(streamingIds);
      setOfflineModelIds(offlineIds);
      setSttPadIds(padSttIds);
      setSttPadPath(padSttIds.length > 0 ? padPath : null);
      setSttFileBackedIds(fileBackedUnion);

      const initialModel =
        engineMode === 'streaming'
          ? available.find((m) => streamingIds.has(m))
          : available.find((m) => offlineIds.has(m));

      setSelectedModelFolder((prev) =>
        prev && available.includes(prev) ? prev : initialModel ?? null
      );
      if (available.length === 0) {
        setStatus(
          'No STT models found. Install/download a model to use this screen.'
        );
      }
    } catch (loadErr) {
      setError(normalizeErrorMessage(loadErr));
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [engineMode]);

  useEffect(() => {
    loadModels().catch(() => {
      // loadModels already updates state
    });
    const unsubscribe = onModelsListUpdated((category) => {
      if (category === ModelCategory.Stt) {
        loadModels().catch(() => {});
      }
    });
    return unsubscribe;
  }, [loadModels]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const syncTranscript = useCallback(async () => {
    const textBuffer = liveTextBufferRef.current;
    if (!textBuffer) return;

    const bufferId = textBuffer.bufferId;
    const segmentCountNow = await getLiveTextBufferSegmentCount(bufferId);
    const segments =
      segmentCountNow > 0
        ? await getLiveTextBufferSegments(bufferId, 0, segmentCountNow)
        : [];
    const partial = await getLiveTextBufferPartialSlice(bufferId, 0, 4096);

    setSegmentCount(segmentCountNow);
    setCommittedTranscript(
      segments
        .map((segment) => segment.text.trim())
        .filter((segment) => segment.length > 0)
        .join(' ')
        .trim()
    );
    setPartialTranscript(partial.trim());
  }, []);

  const cleanupStream = useCallback(async () => {
    if (cleanupLockRef.current) {
      return;
    }
    cleanupLockRef.current = true;

    try {
      stopPolling();

      try {
        ingestHandleRef.current?.cancel();
      } catch {
        // ignore teardown races
      }
      ingestHandleRef.current = null;

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore teardown races
      }

      try {
        await pipelineRef.current?.stop();
      } catch {
        // ignore teardown races
      }
      pipelineRef.current = null;

      try {
        await engineRef.current?.destroy();
      } catch {
        // ignore teardown races
      }
      engineRef.current = null;

      const textBuffer = liveTextBufferRef.current;
      liveTextBufferRef.current = null;
      if (textBuffer) {
        await releasePipelineTextBuffer(textBuffer.bufferId).catch(() => {});
      }

      const audioBuffer = liveAudioBufferRef.current;
      liveAudioBufferRef.current = null;
      if (audioBuffer) {
        await releasePipelineAudioBuffer(audioBuffer.bufferId).catch(() => {});
      }
    } finally {
      cleanupLockRef.current = false;
    }
  }, [stopPolling]);

  const fillCustomFromSelectedModel = useCallback(async () => {
    if (!selectedModelFolder) {
      setCustomFillHint('Select a catalog model first.');
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    try {
      const modelPath = resolveModelPath(selectedModelFolder);
      const fillResult = await fillStreamingCustomConfigFromFolder({
        modelSource: modelPath,
        modelType: customInitForm.modelType,
      });
      setCustomInitForm({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
      });
      if (fillResult.missingKeys.length > 0) {
        setCustomFillHint(
          `Filled from ${
            fillResult.modelDir
          }; still missing: ${fillResult.missingKeys.join(', ')}`
        );
      } else {
        setCustomFillHint(`Filled all slots from ${fillResult.modelDir}`);
      }
    } catch (err) {
      setCustomFillHint(normalizeErrorMessage(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelFolder]);

  const startStreaming = useCallback(async () => {
    if (streamingState !== 'idle') {
      return;
    }
    const isStreamingCustom =
      engineMode === 'streaming' && initMode === 'custom';
    if (!isStreamingCustom && !selectedModelFolder) {
      setError('Select an STT model first.');
      return;
    }
    if (sourceMode === 'file' && !selectedFileUri) {
      setError('Pick an audio file first.');
      return;
    }

    setError(null);
    setProgress(null);
    setSegmentCount(0);
    setCommittedTranscript('');
    setPartialTranscript('');
    setStreamingState('starting');

    try {
      if (engineMode === 'streaming' && initMode === 'custom') {
        const customConfig = {
          ...customInitForm.fileSources,
        } as StreamingSttCustomConfig;
        assertStreamingSttCustomConfig(
          customConfig as unknown as Record<string, unknown>
        );
        const engine = await createStreamingSTT({
          initMode: 'custom',
          modelType: customInitForm.modelType,
          customConfig,
          numThreads: 2,
        });
        engineRef.current = engine;
      } else {
        const modelPath = resolveModelPath(selectedModelFolder!);
        const detectSource = await toDetectSource(modelPath);
        const detection = await detectSttModel(detectSource, {
          modelType: 'auto',
        });
        if (!detection.success) {
          throw new Error(detection.error ?? 'STT model detection failed');
        }
        if (engineMode === 'streaming' && !detection.isStreaming) {
          throw new Error(
            'This STT model is offline-only. Switch to "Live Overload" mode to use it.'
          );
        }
        if (engineMode === 'offline' && detection.isStreaming) {
          throw new Error(
            'This STT model is streaming-only (incremental encoder). Live Overload needs offline weights — pick another model or use ⚡ Streaming.'
          );
        }

        if (engineMode === 'streaming') {
          const engine = await createStreamingSTT({
            modelSource: modelPath,
            modelType: 'auto',
            numThreads: 2,
          });
          engineRef.current = engine;
        } else {
          const { createSTT } = require('react-native-sherpa-onnx/stt');
          const engine = await createSTT({
            modelSource: modelPath,
            modelType: 'auto',
            numThreads: 2,
          });
          engineRef.current = engine;
        }
      }

      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: STT_INPUT_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      liveAudioBufferRef.current = liveAudio;

      const liveText = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: false, minIntervalMs: 0 } },
      });
      liveTextBufferRef.current = liveText;

      const segOpt = buildSegmentationOption(segConfig);
      const pipeline = await engineRef.current!.transcribe(
        liveAudio.bufferId,
        liveText.bufferId,
        {
          chunkSize: 3200,
          ...(segOpt && segOpt.mode !== 'off' ? { segmentation: segOpt } : {}),
        }
      );
      pipelineRef.current = pipeline;

      let fileIngestDone: Promise<unknown> = Promise.resolve();

      if (sourceMode === 'file') {
        const source = toFileSource(
          selectedFileUri!,
          selectedFileName ?? undefined
        );
        const ingest = await ingestFileToLiveAudioBuffer(
          liveAudio.bufferId,
          source,
          {
            targetSampleRateHz: STT_INPUT_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
            backpressure: 'block',
            onProgress: (event) => {
              setProgress(event.percent);
              setStatus(
                `Streaming decode ${event.percent.toFixed(
                  0
                )}% • ${event.framesDecoded.toLocaleString()} frames decoded`
              );
            },
          }
        );
        ingestHandleRef.current = ingest;
        fileIngestDone = ingest.done;
        setStatus(
          'Streaming STT is running. The live buffer stays lossless while the text buffer tracks committed and partial text.'
        );
      } else {
        ingestHandleRef.current = null;
        await startMicToLiveAudioBuffer(liveAudio, { emitToJs: false });
        setStatus(
          'Microphone active. Speak to transcribe; tap Stop when finished.'
        );
      }

      setStreamingState('running');

      stopPolling();
      pollTimerRef.current = setInterval(() => {
        syncTranscript().catch(() => {
          // ignore polling races during teardown
        });
      }, 150);

      (async () => {
        try {
          if (sourceMode === 'file') {
            await Promise.all([fileIngestDone, pipeline.completed]);
          } else {
            await pipeline.completed;
          }
          setStatus('Streaming transcription completed.');
        } catch (streamErr) {
          const code = (streamErr as { code?: string })?.code;
          if (code !== 'DECODE_CANCELLED') {
            setError(normalizeErrorMessage(streamErr));
            setStatus('Streaming transcription failed.');
          }
        } finally {
          await syncTranscript().catch(() => {});
          await cleanupStream();
          setStreamingState('idle');
        }
      })().catch(() => {});
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStreamingState('idle');
      await cleanupStream();
    }
  }, [
    cleanupStream,
    customInitForm,
    engineMode,
    initMode,
    resolveModelPath,
    segConfig,
    selectedFileUri,
    selectedFileName,
    sourceMode,
    selectedModelFolder,
    stopPolling,
    streamingState,
    syncTranscript,
  ]);

  const stopStreaming = useCallback(async () => {
    if (streamingState === 'idle') {
      return;
    }
    setStreamingState('stopping');
    setStatus('Stopping streaming transcription...');
    try {
      await pipelineRef.current?.stop();
    } catch {
      // ignore stop races
    }
    try {
      ingestHandleRef.current?.cancel();
    } catch {
      // ignore stop races
    }
    await cleanupStream();
    setStreamingState('idle');
    setStatus('Stopped.');
  }, [cleanupStream, streamingState]);

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
      }
    } catch (pickErr) {
      const isPickCancel =
        (DocumentPicker as any)?.isCancel?.(pickErr) ||
        (pickErr as any)?.code === 'DOCUMENT_PICKER_CANCELED' ||
        (pickErr as any)?.name === 'DocumentPickerCanceled';
      if (!isPickCancel) {
        setError(normalizeErrorMessage(pickErr));
      }
    }
  }, []);

  const clearSelectedFile = useCallback(() => {
    if (streamingState !== 'idle') {
      return;
    }
    setSelectedFileUri(null);
    setSelectedFileName(null);
    setProgress(null);
    setStatus('Audio file removed. Choose another file to continue.');
  }, [streamingState]);

  const canStartCustomStreaming =
    engineMode === 'streaming' &&
    initMode === 'custom' &&
    Object.keys(customInitForm.fileSources).length > 0;

  const canStart =
    streamingState === 'idle' &&
    (sourceMode === 'mic' || !!selectedFileUri) &&
    (canStartCustomStreaming || !!selectedModelFolder);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="chatbubbles-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Speech-to-Text Streaming</Text>
        </View>

        <EngineModeModelSelector
          label="STT Engine"
          engineMode={engineMode}
          onEngineModeChange={setEngineMode}
          models={availableModels}
          selectedModel={selectedModelFolder}
          onModelSelect={setSelectedModelFolder}
          isModelStreamingCapable={(m) => streamingModelIds.has(m)}
          isModelOfflineCapable={(m) => offlineModelIds.has(m)}
          loading={loadingModels}
          disabled={streamingState !== 'idle'}
        />

        {engineMode === 'streaming' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Initialization</Text>
            <InitModeSelector
              value={initMode}
              onChange={setInitMode}
              disabled={streamingState !== 'idle' || customFillLoading}
            />
            {initMode === 'custom' ? (
              <StreamingSttCustomInitForm
                value={customInitForm}
                onChange={setCustomInitForm}
                selectedCatalogModelId={selectedModelFolder}
                onFillFromSelectedModel={fillCustomFromSelectedModel}
                fillLoading={customFillLoading}
                disabled={streamingState !== 'idle'}
                fillHint={customFillHint}
              />
            ) : (
              <Text style={styles.bodyText}>
                Auto mode scans the selected model folder for streaming ONNX
                files.
              </Text>
            )}
          </View>
        )}

        {engineMode === 'offline' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Speech Segmentation</Text>
            <Text style={styles.bodyText}>
              Live Overload requires segmentation to commit speech into discrete
              chunks before transcription. The 'Off' option is disabled.
            </Text>
            <SegmentationPolicyControls
              variant="speech-offline"
              value={segConfig}
              onChange={setSegConfig}
              disabled={streamingState !== 'idle'}
              disableOff
              offDisabledMessage="Live Overload requires mandatory segmentation to commit speech segments for transcription."
            />
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Input Source</Text>
          <View style={lpStyles.sourceToggle}>
            {(['mic', 'file'] as SourceMode[]).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={[
                  lpStyles.sourceToggleBtn,
                  sourceMode === mode && lpStyles.sourceToggleBtnActive,
                ]}
                onPress={() => setSourceMode(mode)}
                disabled={streamingState !== 'idle'}
              >
                <Text
                  style={[
                    lpStyles.sourceToggleText,
                    sourceMode === mode && lpStyles.sourceToggleTextActive,
                  ]}
                >
                  {mode === 'mic' ? '🎤 Microphone' : '📁 File'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {sourceMode === 'file' && (
            <>
              {!selectedFileUri ? (
                <>
                  <TouchableOpacity
                    style={[
                      lpStyles.optionButton,
                      lpStyles.optionButtonAlignStart,
                      styles.inputSourcePickButton,
                    ]}
                    onPress={() => {
                      pickFile().catch(() => {});
                    }}
                    disabled={streamingState !== 'idle'}
                  >
                    <Text style={lpStyles.optionButtonText}>
                      Pick audio file…
                    </Text>
                  </TouchableOpacity>
                  <Text style={[styles.bodyText, styles.inputSourceFileHint]}>
                    No file selected yet.
                  </Text>
                </>
              ) : (
                <View
                  style={[styles.selectedFileCard, styles.inputSourceFileCard]}
                >
                  <View style={styles.selectedFileInfo}>
                    <Text style={styles.selectedFileLabel}>Selected file</Text>
                    <Text style={styles.selectedFileName} numberOfLines={2}>
                      {selectedFileName ?? selectedFileUri}
                    </Text>
                  </View>
                  <Pressable
                    style={[
                      styles.removeFileButton,
                      streamingState !== 'idle' && styles.buttonDisabled,
                    ]}
                    onPress={clearSelectedFile}
                    disabled={streamingState !== 'idle'}
                    accessibilityLabel="Remove selected audio file"
                  >
                    <Ionicons name="trash-outline" size={18} color="#B42318" />
                  </Pressable>
                </View>
              )}
            </>
          )}
          {sourceMode === 'mic' ? (
            <Text style={[styles.bodyText, styles.inputSourceMicHint]}>
              Audio is captured from the device microphone at{' '}
              {STT_INPUT_SAMPLE_RATE} Hz mono. Grant mic permission when
              prompted.
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Run</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.primaryButton,
                (!canStart || streamingState !== 'idle') &&
                  styles.buttonDisabled,
              ]}
              onPress={() => {
                startStreaming().catch(() => {});
              }}
              disabled={!canStart || streamingState !== 'idle'}
            >
              <Text style={styles.primaryButtonText}>Start streaming</Text>
            </Pressable>
            <Pressable
              style={[
                styles.secondaryButton,
                streamingState === 'idle' && styles.buttonDisabled,
              ]}
              onPress={() => {
                stopStreaming().catch(() => {});
              }}
              disabled={streamingState === 'idle'}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          </View>
          <Text style={styles.mutedText}>{status}</Text>
          {sourceMode === 'file' && progress != null ? (
            <Text style={styles.mutedText}>
              Decode progress: {progress.toFixed(0)}%
            </Text>
          ) : null}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Live transcript</Text>
          <Text style={styles.metricText}>Segments: {segmentCount}</Text>
          <Text style={styles.sectionLabel}>Committed</Text>
          <Text style={styles.transcriptBox} selectable>
            {committedTranscript || 'Waiting for committed segments...'}
          </Text>
          <Text style={styles.sectionLabel}>Partial</Text>
          <Text style={styles.transcriptBox} selectable>
            {partialTranscript || 'Waiting for partial text...'}
          </Text>
        </View>
      </ScrollView>

      <ScreenIntroModal screenId="STTStreaming" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    gap: 14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 2,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E8F1FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    color: '#111827',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mutedText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#6B7280',
  },
  bodyText: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  inputSourcePickButton: {
    marginTop: 12,
  },
  inputSourceFileHint: {
    marginTop: 10,
  },
  inputSourceFileCard: {
    marginTop: 12,
  },
  inputSourceMicHint: {
    marginTop: 12,
  },
  selectedFileCard: {
    marginTop: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  selectedFileInfo: {
    flex: 1,
  },
  selectedFileLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  selectedFileName: {
    fontSize: 14,
    lineHeight: 20,
    color: '#111827',
    fontWeight: '600',
  },
  removeFileButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#F4C7C3',
    backgroundColor: '#FFF5F4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelList: {
    gap: 8,
  },
  modelListItem: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: '#F2F2F7',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  modelListItemSelected: {
    backgroundColor: '#EBF3FF',
    borderColor: '#0F62FE',
  },
  modelListTitle: {
    color: '#111827',
    fontWeight: '700',
    marginBottom: 2,
  },
  modelListTitleSelected: {
    color: '#0F62FE',
  },
  modelListSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    color: '#6B7280',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#E5E7EB',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  errorText: {
    marginTop: 10,
    color: '#B42318',
    fontWeight: '600',
  },
  metricText: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 10,
  },
  sectionLabel: {
    marginTop: 6,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  transcriptBox: {
    minHeight: 72,
    borderRadius: 14,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    fontSize: 15,
    lineHeight: 22,
    color: '#111827',
  },
});
