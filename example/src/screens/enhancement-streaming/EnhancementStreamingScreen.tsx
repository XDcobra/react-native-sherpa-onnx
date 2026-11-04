import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  StyleSheet,
} from 'react-native';
import { styles } from '../stt/STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as DocumentPicker from '@react-native-documents/picker';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import type { EnhancementPipelineHandle } from 'react-native-sherpa-onnx/enhancement';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromLive,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { AudioSaveDestinationPicker } from '../../components/AudioSaveDestinationPicker';
import { formatResolvedLocation } from '../../components/audioSaveUtils';
import { getSegments } from 'react-native-sherpa-onnx/segment';
import { EnhancementStreamingModelInitPanel } from '../../components/EnhancementStreamingModelInitPanel';
import { useEnhancementStreamingModelInit } from '../../hooks/useEnhancementStreamingModelInit';
import type { RootStackParamList } from '../../types/navigation';
import {
  getAudioFilesForEnhancement,
  type AudioFileInfo,
} from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  startPcmFilePlayback,
  stopPcmFilePlayback,
  type ActivePcmFilePlayback,
} from '../../utils/audioFilePcmPlayback';
import { AudioDeviceDropdown } from '../../components/AudioDeviceDropdown';
import {
  fetchOutputDevices,
  keepValidDeviceSelection,
  type AudioRouteDevice,
} from '../../utils/audioDevices';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { VoxLockReferenceAudioPicker } from '../../components/VoxLockReferenceAudioPicker';

type SelectedEnhancementInput = {
  source: FileSource;
  sourceType: 'example' | 'own';
  sourceLabel: string;
  sourcePathForPlayback: string;
  selectedAudioId: string | null;
  customAudioPath: string | null;
  customAudioName: string | null;
};

const localStyles = StyleSheet.create({
  sourceActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  sourceActionTitle: {
    flex: 1,
    marginBottom: 0,
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    alignItems: 'stretch',
  },
  playHalf: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  playDisabled: {
    opacity: 0.45,
  },
});

const PIPELINE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export default function EnhancementStreamingScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );
  const onEngineReadyRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );

  const enhancement = useEnhancementStreamingModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
    onEngineReady: () => onEngineReadyRef.current?.(),
  });

  const {
    engineRef,
    isEngineInitialized,
    initMode,
    customInitForm,
    selectedModelForInit,
    currentModelFolder,
    detectedModels,
    selectedModelKind,
    loading,
    reinitWithKind,
    releaseEngine,
    engineMode,
  } = enhancement;

  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'init' | 'enhance' | null>(
    null
  );
  const [audioSourceType, setAudioSourceType] = useState<
    'example' | 'own' | null
  >(null);
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(
    null
  );
  const [customAudioPath, setCustomAudioPath] = useState<string | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);
  const [preparingInputBuffer, setPreparingInputBuffer] = useState(false);
  const [inputBufferBuildProgress, setInputBufferBuildProgress] = useState<
    number | null
  >(null);
  const [inputBufferBuildStatus, setInputBufferBuildStatus] = useState<
    string | null
  >(null);
  const [enhancing, setEnhancing] = useState(false);
  const [segStreamingConfig, setSegStreamingConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [enhanceResult, setEnhanceResult] = useState<string | null>(null);
  const [lastInputPath, setLastInputPath] = useState<string | null>(null);
  const [lastEnhancedAudio, setLastEnhancedAudio] = useState<{
    outputBufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);
  const [activePlaybackKind, setActivePlaybackKind] = useState<
    'original' | 'enhanced' | null
  >(null);

  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);

  const pcmPlaybackRef = useRef<ActivePcmFilePlayback | null>(null);
  const enhancedOutputPlayerRef = useRef<PcmPlayer | null>(null);
  const fileIngestRef = useRef<FileIngestHandle | null>(null);
  const outputLiveBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const pipelineRef = useRef<EnhancementPipelineHandle | null>(null);
  const finalizedOutputBufferIdRef = useRef<string | null>(null);

  const stopActivePlayback = async () => {
    const enhanced = enhancedOutputPlayerRef.current;
    enhancedOutputPlayerRef.current = null;
    if (enhanced) {
      await enhanced.destroy().catch(() => {});
    }
    if (pcmPlaybackRef.current) {
      const activePlayback = pcmPlaybackRef.current;
      pcmPlaybackRef.current = null;
      await stopPcmFilePlayback(activePlayback);
    }
    setActivePlaybackKind(null);
  };

  const refreshOutputDevices = useCallback(async () => {
    const nextOutputDevices = await fetchOutputDevices();
    setOutputDevices(nextOutputDevices);
    setSelectedOutputDeviceId((prev) =>
      keepValidDeviceSelection(prev, nextOutputDevices)
    );
  }, []);

  const clearFinalizedOutput = async () => {
    const existingOutputBufferId = finalizedOutputBufferIdRef.current;
    finalizedOutputBufferIdRef.current = null;
    if (existingOutputBufferId) {
      await releasePipelineAudioBuffer(existingOutputBufferId).catch(() => {});
    }
    setLastEnhancedAudio(null);
    setEnhanceResult(null);
  };

  const cleanupRuntimeResources = async () => {
    const ingest = fileIngestRef.current;
    fileIngestRef.current = null;
    if (ingest) {
      try {
        const status = await ingest.getStatus();
        if (status.isRunning) {
          ingest.cancel();
        }
      } catch {
        // Ignore status races.
      }
    }

    const pipeline = pipelineRef.current;
    pipelineRef.current = null;
    if (pipeline) {
      await pipeline.stop().catch(() => {});
    }

    const outputLiveBuffer = outputLiveBufferRef.current;
    outputLiveBufferRef.current = null;
    if (outputLiveBuffer?.bufferId) {
      await releasePipelineAudioBuffer(outputLiveBuffer.bufferId).catch(
        () => {}
      );
    }
  };

  const clearPreparedInputBuffer = async () => {
    const ingest = fileIngestRef.current;
    fileIngestRef.current = null;
    if (ingest) {
      try {
        const status = await ingest.getStatus();
        if (status.isRunning) {
          ingest.cancel();
        }
      } catch {
        // Ignore status races.
      }
    }

    setPreparingInputBuffer(false);
    setInputBufferBuildProgress(null);
    setInputBufferBuildStatus(null);
  };

  const resolveSelectedInputSource = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ): Promise<SelectedEnhancementInput> => {
    const effectiveCustomAudioPath =
      override?.customAudioPath ?? customAudioPath;
    const effectiveCustomAudioName =
      override?.customAudioName ?? customAudioName;
    const effectiveSelectedAudio = override?.selectedAudio ?? selectedAudio;

    if (effectiveCustomAudioPath) {
      const trimmed = effectiveCustomAudioPath.trim();
      if (trimmed.startsWith('content://')) {
        return {
          source: toFileSource(trimmed, effectiveCustomAudioName ?? undefined),
          sourceType: 'own',
          sourceLabel: effectiveCustomAudioName ?? 'Local audio',
          sourcePathForPlayback: trimmed,
          selectedAudioId: null,
          customAudioPath: effectiveCustomAudioPath,
          customAudioName: effectiveCustomAudioName,
        };
      }
      if (trimmed.startsWith('file://')) {
        const filePath = decodeURI(trimmed.replace(/^file:\/\//, ''));
        if (filePath.startsWith('/proc/self/fd/')) {
          throw new Error(
            'The selected file points to an ephemeral file descriptor. Please re-pick using a regular file from Files/Documents.'
          );
        }
        return {
          source: { kind: 'fs', path: filePath },
          sourceType: 'own',
          sourceLabel: effectiveCustomAudioName ?? 'Local audio',
          sourcePathForPlayback: effectiveCustomAudioPath,
          selectedAudioId: null,
          customAudioPath: effectiveCustomAudioPath,
          customAudioName: effectiveCustomAudioName,
        };
      }
      if (trimmed.startsWith('/proc/self/fd/')) {
        throw new Error(
          'The selected file points to an ephemeral file descriptor. Please re-pick using a regular file from Files/Documents.'
        );
      }
      return {
        source: { kind: 'fs', path: trimmed },
        sourceType: 'own',
        sourceLabel: effectiveCustomAudioName ?? 'Local audio',
        sourcePathForPlayback: trimmed,
        selectedAudioId: null,
        customAudioPath: effectiveCustomAudioPath,
        customAudioName: effectiveCustomAudioName,
      };
    }

    if (effectiveSelectedAudio) {
      const source = fileSourceFromBundledPath(effectiveSelectedAudio.id);
      return {
        source,
        sourceType: 'example',
        sourceLabel: effectiveSelectedAudio.name,
        sourcePathForPlayback: effectiveSelectedAudio.id,
        selectedAudioId: effectiveSelectedAudio.id,
        customAudioPath: null,
        customAudioName: null,
      };
    }

    throw new Error('Select example audio or a local WAV file');
  };

  // Auto-enforce segmentation when switching to Live Overload mode
  useEffect(() => {
    if (engineMode === 'offline') {
      setSegStreamingConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: { evaluator: 'continuous_frames' },
          };
        }
        return prev;
      });
    }
  }, [engineMode]);

  useEffect(() => {
    return () => {
      const ep = enhancedOutputPlayerRef.current;
      enhancedOutputPlayerRef.current = null;
      if (ep) {
        ep.destroy().catch(() => {});
      }
      if (pcmPlaybackRef.current) {
        stopPcmFilePlayback(pcmPlaybackRef.current).catch(() => {});
        pcmPlaybackRef.current = null;
      }
      cleanupRuntimeResources().catch(() => {});
      const outputBufferId = finalizedOutputBufferIdRef.current;
      finalizedOutputBufferIdRef.current = null;
      if (outputBufferId) {
        releasePipelineAudioBuffer(outputBufferId).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    refreshOutputDevices().catch(() => {
      // Ignore unsupported-platform lookup failures.
    });
  }, [refreshOutputDevices]);

  onBeforeInitRef.current = async () => {
    setError(null);
    setErrorSource(null);
    await stopActivePlayback();
    await cleanupRuntimeResources();
    await clearFinalizedOutput();
    await clearPreparedInputBuffer();
    setEnhanceResult(null);
    setLastInputPath(null);
    setAudioSourceType(null);
    setSelectedAudio(null);
    setCustomAudioPath(null);
    setCustomAudioName(null);
  };

  onEngineReadyRef.current = async () => {
    await onBeforeInitRef.current?.();
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setErrorSource(null);
    try {
      const res = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      const file = Array.isArray(res) ? res[0] : res;
      const uri =
        file.uri ??
        (file as any).fileCopyUri ??
        (file as any).localUri ??
        (file as any).nativeUri;
      const name =
        resolveAudioFileDisplayName(uri, file.name) ??
        file.name?.trim() ??
        uri?.split('/')?.pop() ??
        'local.wav';
      if (!uri) {
        setErrorSource('enhance');
        setError('Could not get file URI from picker result');
        return;
      }
      const fsPathProbe = uri.startsWith('file://')
        ? decodeURI(uri.replace(/^file:\/\//, ''))
        : uri;
      if (
        uri.startsWith('/proc/self/fd/') ||
        fsPathProbe.startsWith('/proc/self/fd/')
      ) {
        setErrorSource('enhance');
        setError(
          'The picker returned an ephemeral fd path. Please select a file from Documents/Files so we get a content:// or file:// URI.'
        );
        return;
      }

      await handleEnhance({
        customAudioPath: uri,
        customAudioName: name,
      });
    } catch (err: any) {
      const isCancel =
        (DocumentPicker &&
          typeof (DocumentPicker as any).isCancel === 'function' &&
          (DocumentPicker as any).isCancel(err)) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled' ||
        (typeof err?.message === 'string' &&
          err.message.toLowerCase().includes('cancel'));
      if (isCancel) return;
      setErrorSource('enhance');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const playPath = async (
    path: string | null,
    options?: { bindResultOriginalUi?: boolean; displayName?: string | null }
  ) => {
    if (!path) return;
    const bindResult = options?.bindResultOriginalUi === true;
    try {
      await stopActivePlayback();
      let nextPlayback: ActivePcmFilePlayback | null = null;
      nextPlayback = await startPcmFilePlayback(
        path,
        () => {
          if (pcmPlaybackRef.current === nextPlayback) {
            pcmPlaybackRef.current = null;
          }
          if (bindResult) {
            setActivePlaybackKind(null);
          }
        },
        {
          outputDeviceId: selectedOutputDeviceId ?? undefined,
          displayName: options?.displayName ?? undefined,
        }
      );
      pcmPlaybackRef.current = nextPlayback;
      if (bindResult) {
        setActivePlaybackKind('original');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
    }
  };

  const togglePlayOriginalPath = async () => {
    if (!lastInputPath) return;
    if (pcmPlaybackRef.current) {
      await stopActivePlayback();
      return;
    }
    await playPath(lastInputPath, { bindResultOriginalUi: true });
  };

  const togglePlayEnhancedOutput = async () => {
    const bufferId = lastEnhancedAudio?.outputBufferId;
    if (!bufferId) return;
    if (enhancedOutputPlayerRef.current) {
      await stopActivePlayback();
      return;
    }
    try {
      await stopActivePlayback();
      await setPipelineAudioRoutePreference({
        outputDeviceId: selectedOutputDeviceId ?? null,
      }).catch(() => {});
      const player = await createPcmPlayer(bufferId, {
        onEnded: () => {
          if (enhancedOutputPlayerRef.current === player) {
            enhancedOutputPlayerRef.current = null;
          }
          setActivePlaybackKind(null);
        },
      });
      enhancedOutputPlayerRef.current = player;
      setActivePlaybackKind('enhanced');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
    }
  };

  const resultPlaybackLabel =
    selectedModelKind === 'voxlock' ? 'Isolated' : 'Enhanced';
  const enhancementAudioFiles = useMemo(
    () =>
      getAudioFilesForEnhancement({
        modelFolder: currentModelFolder ?? selectedModelForInit,
        modelType:
          initMode === 'custom' ? customInitForm.modelType : selectedModelKind,
      }),
    [
      currentModelFolder,
      customInitForm.modelType,
      initMode,
      selectedModelForInit,
      selectedModelKind,
    ]
  );

  const handleEnhance = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ) => {
    if (!isEngineInitialized || !engineRef.current) {
      setErrorSource('enhance');
      setError('Please initialize a model first');
      return;
    }

    setEnhancing(true);
    setPreparingInputBuffer(true);
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setLastInputPath(null);
    setInputBufferBuildProgress(0);
    setInputBufferBuildStatus('Preparing streaming pipeline...');

    let producedOfflineBufferId: string | null = null;

    try {
      const engine = engineRef.current!;
      const selectedInput = await resolveSelectedInputSource(override);
      setAudioSourceType(selectedInput.sourceType);
      setSelectedAudio(
        selectedInput.sourceType === 'example'
          ? enhancementAudioFiles.find(
              (f) => f.id === selectedInput.selectedAudioId
            ) ?? null
          : null
      );
      setCustomAudioPath(selectedInput.customAudioPath);
      setCustomAudioName(selectedInput.customAudioName);

      await stopActivePlayback();
      await cleanupRuntimeResources();
      await clearFinalizedOutput();

      const sampleRate = await engine.getSampleRate();
      const frameShift = await engine.getFrameShiftInSamples();
      setInputBufferBuildStatus('Creating live buffers...');

      const inputLive = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      const outputLivePath = `${DocumentDirectoryPath}/streaming_enhancement_live_${Date.now()}.wav`;
      const outputLive = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: { mode: 'path', path: outputLivePath },
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      outputLiveBufferRef.current = outputLive;

      setInputBufferBuildStatus('Starting enhancement pipeline...');
      const pipeline = await engine.enhance(
        inputLive.bufferId,
        outputLive.bufferId,
        segStreamingConfig.mode === 'off'
          ? undefined
          : { segmentation: buildSegmentationOption(segStreamingConfig) }
      );
      pipelineRef.current = pipeline;
      setInputBufferBuildStatus(
        `Decoding and streaming "${selectedInput.sourceLabel}"...`
      );

      const ingest = await ingestFileToLiveAudioBuffer(
        inputLive.bufferId,
        selectedInput.source,
        {
          targetSampleRateHz: sampleRate,
          forceMono: true,
          autoFinalize: true,
          onProgress: (event) => {
            const percent = Math.max(0, Math.min(100, event.percent ?? 0));
            setInputBufferBuildProgress(percent);
            setInputBufferBuildStatus(
              `Decoding and streaming "${
                selectedInput.sourceLabel
              }"... ${Math.round(percent)}%`
            );
          },
        }
      );
      fileIngestRef.current = ingest;
      await ingest.done;
      if (fileIngestRef.current === ingest) {
        fileIngestRef.current = null;
      }

      const completion = await new Promise<Awaited<typeof pipeline.completed>>(
        (resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Enhancement pipeline timeout after ${PIPELINE_WAIT_TIMEOUT_MS}ms`
              )
            );
          }, PIPELINE_WAIT_TIMEOUT_MS);

          pipeline.completed.then(
            (result) => {
              clearTimeout(timeoutId);
              resolve(result);
            },
            (pipelineError) => {
              clearTimeout(timeoutId);
              reject(pipelineError);
            }
          );
        }
      );

      if (completion.reason === 'stopped') {
        throw new Error('Enhancement pipeline was stopped before completion.');
      }

      pipelineRef.current = null;

      const checkpointCount =
        segStreamingConfig.mode !== 'off' &&
        segStreamingConfig.policy?.evaluator === 'continuous_frames'
          ? (
              await getSegments(inputLive.bufferId, 0, 100000).catch(() => [])
            ).filter((segment) => segment.reason === 'policy_checkpoint').length
          : 0;

      setInputBufferBuildProgress(100);
      setInputBufferBuildStatus('Finalizing output...');
      await finalizeLiveAudioBuffer(outputLive.bufferId).catch(() => {});

      const offlineOutput = await createOfflineAudioBufferFromLive(
        outputLive.bufferId,
        { mode: 'fullIfSpooled' }
      );
      producedOfflineBufferId = offlineOutput.bufferId;

      const outInfo = await getPipelineAudioBufferInfo(offlineOutput.bufferId);
      const numSamples =
        outInfo.kind === 'offlinePcmBuffer' ? outInfo.numSamples : 0;
      const outputSampleRate = outInfo.sampleRate ?? sampleRate;
      const durationSeconds =
        outputSampleRate > 0 ? (numSamples / outputSampleRate).toFixed(2) : '?';

      finalizedOutputBufferIdRef.current = offlineOutput.bufferId;
      setLastEnhancedAudio({
        outputBufferId: offlineOutput.bufferId,
        sampleRate: outputSampleRate,
        numSamples,
      });
      setLastInputPath(selectedInput.sourcePathForPlayback);
      setEnhanceResult(
        `Pipeline: streaming enhancement\nContinuous checkpoints: ${checkpointCount}\nFrame shift: ${frameShift} samples\nSamples: ${numSamples}\nSample rate: ${outputSampleRate} Hz\nDuration: ~${durationSeconds} s\nUse “Save to” below to export a file.`
      );
      producedOfflineBufferId = null;
      setInputBufferBuildProgress(null);
      setInputBufferBuildStatus(null);
    } catch (err) {
      if (producedOfflineBufferId) {
        await releasePipelineAudioBuffer(producedOfflineBufferId).catch(
          () => {}
        );
      }

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${(err as any).code}] ${errorMessage}`;
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
      }
      setErrorSource('enhance');
      setError(errorMessage);
      setInputBufferBuildProgress(null);
      setInputBufferBuildStatus(null);
    } finally {
      await cleanupRuntimeResources();
      setPreparingInputBuffer(false);
      setEnhancing(false);
    }
  };

  const handleReleaseAll = async () => {
    await stopActivePlayback();
    await cleanupRuntimeResources();
    await clearFinalizedOutput();
    await clearPreparedInputBuffer();
    await releaseEngine();
    setError(null);
    setErrorSource(null);
  };

  const applyVoxLockVoiceSample = useCallback(
    async (bufferId: string) => {
      const engine = engineRef.current;
      if (!engine || engine.modelType !== 'voxlock') {
        throw new Error('VoxLock engine is not initialized');
      }
      await engine.setVoiceSample(bufferId);
    },
    [engineRef]
  );

  const engineReady = isEngineInitialized && engineRef.current != null;
  const voxLockEngineId =
    engineReady && engineRef.current?.modelType === 'voxlock'
      ? engineRef.current.instanceId
      : null;
  const showKindPicker =
    detectedModels.length > 1 &&
    detectedModels.some((m) => m.type === 'gtcrn') &&
    detectedModels.some((m) => m.type === 'dpdfnet');

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
        >
          <EnhancementStreamingModelInitPanel
            enhancement={enhancement}
            disabled={enhancing}
            onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
          />

          {showKindPicker && engineReady && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Architecture</Text>
              <Text style={styles.hint}>
                This folder contains both GTCRN and DPDFNet. Pick which
                checkpoint to use, then stream a file below.
              </Text>
              <View style={styles.detectedModelsContainer}>
                {(['gtcrn', 'dpdfnet'] as const).map((kind) => (
                  <TouchableOpacity
                    key={kind}
                    style={[
                      styles.detectedModelButton,
                      selectedModelKind === kind &&
                        styles.detectedModelButtonActive,
                    ]}
                    onPress={() => {
                      reinitWithKind(kind);
                    }}
                    disabled={loading || enhancing}
                  >
                    <Text
                      style={[
                        styles.detectedModelButtonText,
                        selectedModelKind === kind &&
                          styles.detectedModelButtonTextActive,
                      ]}
                    >
                      {kind.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {engineReady ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {showKindPicker
                  ? '3. Stream enhancement'
                  : '2. Stream enhancement'}
              </Text>
              <Text style={styles.hint}>
                Same UX as offline enhancement, but processing runs as a
                streaming pipeline with live buffers to avoid offline OOM on
                long audio.
              </Text>

              <VoxLockReferenceAudioPicker
                key={voxLockEngineId ?? 'voxlock-ref'}
                visible={voxLockEngineId != null}
                disabled={enhancing || loading || preparingInputBuffer}
                applyVoiceSample={applyVoxLockVoiceSample}
              />

              <AudioDeviceDropdown
                label="Output device"
                devices={outputDevices}
                selectedDeviceId={selectedOutputDeviceId}
                onSelectDeviceId={setSelectedOutputDeviceId}
                disabled={enhancing || loading || preparingInputBuffer}
              />

              {engineMode === 'streaming' && (
                <SegmentationPolicyControls
                  variant="speech-streaming"
                  value={segStreamingConfig}
                  onChange={setSegStreamingConfig}
                  disabled={enhancing || loading || preparingInputBuffer}
                />
              )}

              {engineMode === 'offline' && (
                <SegmentationPolicyControls
                  variant="speech-offline"
                  value={segStreamingConfig}
                  onChange={setSegStreamingConfig}
                  disabled={enhancing || loading || preparingInputBuffer}
                  disableOff
                  offDisabledMessage="Live Overload requires mandatory segmentation to split audio into processable chunks."
                />
              )}

              {(audioSourceType === 'example' || audioSourceType === 'own') &&
                (preparingInputBuffer || inputBufferBuildStatus != null) && (
                  <View style={styles.decodeProgressContainer}>
                    <View style={styles.decodeProgressHeaderRow}>
                      <Text style={styles.decodeProgressLabel}>
                        {inputBufferBuildStatus ??
                          'Preparing LiveAudioBuffer...'}
                      </Text>
                      {inputBufferBuildProgress != null && (
                        <Text style={styles.decodeProgressPercent}>
                          {Math.round(inputBufferBuildProgress)}%
                        </Text>
                      )}
                    </View>
                    <View style={styles.decodeProgressTrack}>
                      <View
                        style={[
                          styles.decodeProgressFill,
                          {
                            width: `${Math.max(
                              0,
                              Math.min(100, inputBufferBuildProgress ?? 0)
                            )}%`,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.decodeProgressMeta}>
                      Long files are decoded and streamed into a live input
                      buffer.
                    </Text>
                  </View>
                )}

              {!audioSourceType && (
                <>
                  <Text style={styles.subsectionTitle}>Audio source</Text>
                  <View style={styles.sourceChoiceRow}>
                    <TouchableOpacity
                      style={[styles.sourceChoiceButton, styles.flex1]}
                      onPress={() => {
                        setAudioSourceType('example');
                        setSelectedAudio(null);
                        setCustomAudioPath(null);
                        setCustomAudioName(null);
                        clearPreparedInputBuffer().catch(() => {});
                      }}
                      disabled={enhancing || loading || preparingInputBuffer}
                    >
                      <View style={styles.rowCenter}>
                        <Ionicons
                          name="folder-outline"
                          size={18}
                          style={styles.iconInline}
                        />
                        <Text style={styles.sourceChoiceButtonText}>
                          Example audio
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.sourceChoiceButton, styles.flex1]}
                      onPress={() => {
                        setAudioSourceType('own');
                        setSelectedAudio(null);
                        setCustomAudioPath(null);
                        setCustomAudioName(null);
                        clearPreparedInputBuffer().catch(() => {});
                      }}
                      disabled={enhancing || loading || preparingInputBuffer}
                    >
                      <View style={styles.rowCenter}>
                        <Ionicons
                          name="musical-notes"
                          size={18}
                          style={styles.iconInline}
                        />
                        <Text style={styles.sourceChoiceButtonText}>
                          Local file
                        </Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {audioSourceType === 'example' && (
                <>
                  <View style={localStyles.sourceActionRow}>
                    <TouchableOpacity
                      style={[
                        localStyles.backButton,
                        preparingInputBuffer && styles.buttonDisabled,
                      ]}
                      onPress={() => {
                        setAudioSourceType(null);
                        setSelectedAudio(null);
                        clearPreparedInputBuffer().catch(() => {});
                        clearFinalizedOutput().catch(() => {});
                        setLastInputPath(null);
                      }}
                      disabled={preparingInputBuffer}
                      accessibilityLabel="Back"
                    >
                      <Ionicons name="chevron-back" size={22} color="#007AFF" />
                    </TouchableOpacity>
                    <Text
                      style={[
                        styles.subsectionTitle,
                        localStyles.sourceActionTitle,
                      ]}
                    >
                      Select clip
                    </Text>
                  </View>
                  <View style={styles.audioFilesContainer}>
                    {enhancementAudioFiles.map((audioFile) => (
                      <TouchableOpacity
                        key={audioFile.id}
                        style={[
                          styles.audioFileButton,
                          selectedAudio?.id === audioFile.id &&
                            styles.audioFileButtonActive,
                        ]}
                        onPress={() => {
                          handleEnhance({
                            selectedAudio: audioFile,
                          }).catch(() => {});
                        }}
                        disabled={enhancing || loading || preparingInputBuffer}
                      >
                        <Text
                          style={[
                            styles.audioFileButtonText,
                            selectedAudio?.id === audioFile.id &&
                              styles.audioFileButtonTextActive,
                          ]}
                        >
                          {audioFile.name}
                        </Text>
                        <Text style={styles.audioFileDescription}>
                          {audioFile.description}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              {audioSourceType === 'own' && (
                <>
                  {!preparingInputBuffer && (
                    <View style={localStyles.sourceActionRow}>
                      <TouchableOpacity
                        style={[
                          localStyles.backButton,
                          (loading || enhancing) && styles.buttonDisabled,
                        ]}
                        onPress={() => {
                          setAudioSourceType(null);
                          setCustomAudioPath(null);
                          setCustomAudioName(null);
                          clearPreparedInputBuffer().catch(() => {});
                          clearFinalizedOutput().catch(() => {});
                          setLastInputPath(null);
                        }}
                        disabled={loading || enhancing}
                        accessibilityLabel="Back"
                      >
                        <Ionicons
                          name="chevron-back"
                          size={22}
                          color="#007AFF"
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.button,
                          styles.flex1,
                          (loading || enhancing) && styles.buttonDisabled,
                        ]}
                        onPress={handlePickLocalFile}
                        disabled={loading || enhancing}
                      >
                        <View style={styles.rowCenter}>
                          <Ionicons
                            name="folder-open-outline"
                            size={16}
                            style={styles.iconInline}
                          />
                          <Text style={styles.buttonText}>Choose file</Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  )}

                  {customAudioName && (
                    <View style={styles.selectedFileContainer}>
                      <Text style={styles.selectedFileLabel}>Selected:</Text>
                      <Text style={styles.selectedFileName}>
                        {customAudioName}
                      </Text>
                      <TouchableOpacity
                        style={[
                          styles.playButton,
                          preparingInputBuffer && styles.buttonDisabled,
                        ]}
                        onPress={() =>
                          playPath(customAudioPath, {
                            displayName: customAudioName,
                          })
                        }
                        disabled={preparingInputBuffer}
                      >
                        <View style={styles.rowAlignCenter}>
                          <Ionicons
                            name="play"
                            size={16}
                            style={styles.iconInline}
                          />
                          <Text style={styles.playButtonText}>Play input</Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  )}
                </>
              )}

              {enhanceResult && (
                <View style={styles.resultSection}>
                  <Text style={styles.resultLabel}>Enhancement</Text>
                  <Text style={styles.resultText} selectable>
                    {enhanceResult}
                  </Text>
                  <View style={localStyles.playRow}>
                    <TouchableOpacity
                      style={[
                        styles.playButton,
                        localStyles.playHalf,
                        !lastInputPath && localStyles.playDisabled,
                      ]}
                      onPress={() => togglePlayOriginalPath()}
                      disabled={!lastInputPath}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name={
                            activePlaybackKind === 'original' ? 'stop' : 'play'
                          }
                          size={16}
                          style={styles.iconInline}
                        />
                        <Text style={styles.playButtonText}>
                          {activePlaybackKind === 'original'
                            ? 'Stop'
                            : 'Original'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.playButton,
                        localStyles.playHalf,
                        !lastEnhancedAudio && localStyles.playDisabled,
                      ]}
                      onPress={() => togglePlayEnhancedOutput()}
                      disabled={!lastEnhancedAudio}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name={
                            activePlaybackKind === 'enhanced' ? 'stop' : 'play'
                          }
                          size={16}
                          style={styles.iconInline}
                        />
                        <Text style={styles.playButtonText}>
                          {activePlaybackKind === 'enhanced'
                            ? 'Stop'
                            : resultPlaybackLabel}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                  {lastEnhancedAudio && (
                    <View style={styles.mt12}>
                      <AudioSaveDestinationPicker
                        defaultDestinationKind="app"
                        audioInput={lastEnhancedAudio.outputBufferId}
                        filename={`sherpa_streaming_enhanced_${Date.now()}.wav`}
                        format="wav"
                        onSaveComplete={(result) => {
                          const location = formatResolvedLocation(result);
                          Alert.alert('Saved', `Audio saved to:\n${location}`);
                        }}
                        onError={(saveErr) => {
                          Alert.alert('Save failed', saveErr.message);
                        }}
                      />
                    </View>
                  )}
                </View>
              )}

              {error && errorSource === 'enhance' && (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorLabel}>Error:</Text>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.freeButton, styles.mt12]}
                onPress={() => {
                  handleReleaseAll().catch(() => {});
                }}
                disabled={loading || enhancing}
              >
                <Text style={styles.freeButtonText}>
                  Release model & clear buffers
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="EnhancementStreaming" />
    </SafeAreaView>
  );
}
