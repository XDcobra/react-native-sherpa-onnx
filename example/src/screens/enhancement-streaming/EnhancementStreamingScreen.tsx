import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { styles } from '../stt/STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import type { EnhancementPipelineHandle } from 'react-native-sherpa-onnx/enhancement';
import {
  appendOfflineToLiveAudioBuffer,
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromLive,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { getSegments } from 'react-native-sherpa-onnx/segment';
import { EnhancementStreamingModelInitPanel } from '../../components/EnhancementStreamingModelInitPanel';
import { useEnhancementStreamingModelInit } from '../../hooks/useEnhancementStreamingModelInit';
import type { RootStackParamList } from '../../types/navigation';
import { getAudioFilesForEnhancement } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { AudioIngressSourceMode } from '../../components/AudioIngressSourceToggle';
import {
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import { StreamingAudioInputSection } from '../../components/StreamingAudioInputSection';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  PipelineOfflineAudioResultCard,
  type PipelineOfflineAudioResultCardHandle,
} from '../../components/PipelineOfflineAudioResultCard';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { VoxLockReferenceAudioPicker } from '../../components/VoxLockReferenceAudioPicker';

const localStyles = StyleSheet.create({
  playRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    alignItems: 'stretch',
  },
  playOriginal: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  playDisabled: {
    opacity: 0.45,
  },
  enhancedCardWrap: {
    marginTop: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionButton: {
    flex: 1,
  },
});

const PIPELINE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function formatEnhancementError(err: unknown): string {
  if (err instanceof Error) {
    let message = err.message;
    if ('code' in err) {
      message = `[${(err as { code?: string }).code}] ${message}`;
    }
    return message;
  }
  if (typeof err === 'object' && err !== null) {
    const errorObj = err as {
      message?: string;
      userInfo?: { NSLocalizedDescription?: string };
    };
    return (
      errorObj.message ??
      errorObj.userInfo?.NSLocalizedDescription ??
      JSON.stringify(err)
    );
  }
  return 'Unknown error';
}

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
  const [sourceMode, setSourceMode] = useState<AudioIngressSourceMode>('file');
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [micRunning, setMicRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [segStreamingConfig, setSegStreamingConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [enhanceResult, setEnhanceResult] = useState<string | null>(null);
  const [lastEnhancedAudio, setLastEnhancedAudio] = useState<{
    outputBufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);
  const [playingOriginal, setPlayingOriginal] = useState(false);

  const originalPlayerRef = useRef<PcmPlayer | null>(null);
  const enhancedCardRef = useRef<PipelineOfflineAudioResultCardHandle | null>(
    null
  );
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const inputLiveBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const outputLiveBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const pipelineRef = useRef<EnhancementPipelineHandle | null>(null);
  const finalizedOutputBufferIdRef = useRef<string | null>(null);
  const micCompletionWaiterRef = useRef<{
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  } | null>(null);

  const stopOriginalPlayback = async () => {
    const player = originalPlayerRef.current;
    originalPlayerRef.current = null;
    if (player) {
      await player.destroy().catch(() => {});
    }
    setPlayingOriginal(false);
  };

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
    await stopMicToLiveAudioBuffer().catch(() => {});

    const pipeline = pipelineRef.current;
    pipelineRef.current = null;
    if (pipeline) {
      await pipeline.stop().catch(() => {});
    }

    const inputLive = inputLiveBufferRef.current;
    inputLiveBufferRef.current = null;
    if (inputLive?.bufferId) {
      await releasePipelineAudioBuffer(inputLive.bufferId).catch(() => {});
    }

    const outputLive = outputLiveBufferRef.current;
    outputLiveBufferRef.current = null;
    if (outputLive?.bufferId) {
      await releasePipelineAudioBuffer(outputLive.bufferId).catch(() => {});
    }
  };

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
      originalPlayerRef.current?.destroy().catch(() => {});
      originalPlayerRef.current = null;
      cleanupRuntimeResources().catch(() => {});
      const outputBufferId = finalizedOutputBufferIdRef.current;
      finalizedOutputBufferIdRef.current = null;
      if (outputBufferId) {
        releasePipelineAudioBuffer(outputBufferId).catch(() => {});
      }
    };
  }, []);

  onBeforeInitRef.current = async () => {
    setError(null);
    setErrorSource(null);
    setStatus(null);
    setMicRunning(false);
    micCompletionWaiterRef.current = null;
    await stopOriginalPlayback();
    await enhancedCardRef.current?.stop().catch(() => {});
    await cleanupRuntimeResources();
    await clearFinalizedOutput();
    setOfflineInputBuffer(null);
    await offlineWidgetRef.current?.clear().catch(() => {});
  };

  onEngineReadyRef.current = async () => {
    await onBeforeInitRef.current?.();
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

  const finalizeEnhancementOutput = async (
    sampleRate: number,
    frameShift: number,
    inputLiveBufferId: string,
    outputLiveBufferId: string
  ) => {
    const checkpointCount =
      segStreamingConfig.mode !== 'off' &&
      segStreamingConfig.policy?.evaluator === 'continuous_frames'
        ? (
            await getSegments(inputLiveBufferId, 0, 100000).catch(() => [])
          ).filter((segment) => segment.reason === 'policy_checkpoint').length
        : 0;

    setStatus('Finalizing output...');
    await finalizeLiveAudioBuffer(outputLiveBufferId).catch(() => {});

    const offlineOutput = await createOfflineAudioBufferFromLive(
      outputLiveBufferId,
      { mode: 'fullIfSpooled' }
    );

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
    setEnhanceResult(
      `Pipeline: streaming enhancement\nContinuous checkpoints: ${checkpointCount}\nFrame shift: ${frameShift} samples\nSamples: ${numSamples}\nSample rate: ${outputSampleRate} Hz\nDuration: ~${durationSeconds} s\nUse the result card below to play or save.`
    );
    setStatus(null);
  };

  const handleEnhance = async () => {
    if (!isEngineInitialized || !engineRef.current) {
      setErrorSource('enhance');
      setError('Please initialize a model first');
      return;
    }
    if (sourceMode === 'file' && !offlineInputBuffer) {
      setErrorSource('enhance');
      setError('Select and decode an audio file first.');
      return;
    }

    setEnhancing(true);
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setStatus('Preparing streaming pipeline...');

    try {
      const engine = engineRef.current;
      await stopOriginalPlayback();
      await enhancedCardRef.current?.stop().catch(() => {});
      await cleanupRuntimeResources();
      await clearFinalizedOutput();

      const sampleRate = await engine.getSampleRate();
      const frameShift = await engine.getFrameShiftInSamples();

      let ringSeconds = 240;
      if (sourceMode === 'file' && offlineInputBuffer) {
        try {
          const bufInfo = await getPipelineAudioBufferInfo(
            offlineInputBuffer.bufferId
          );
          if (bufInfo && bufInfo.durationMs > 0) {
            ringSeconds = Math.max(
              120,
              Math.ceil(bufInfo.durationMs / 1000) + 30
            );
          }
        } catch {
          ringSeconds = 300;
        }
      }

      const inputLive = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      inputLiveBufferRef.current = inputLive;

      const outputLivePath = `${DocumentDirectoryPath}/streaming_enhancement_live_${Date.now()}.wav`;
      const outputLive = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds,
        retention: { mode: 'path', path: outputLivePath },
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      outputLiveBufferRef.current = outputLive;

      setStatus('Starting enhancement pipeline...');
      const pipeline = await engine.enhance(
        inputLive.bufferId,
        outputLive.bufferId,
        segStreamingConfig.mode === 'off'
          ? undefined
          : { segmentation: buildSegmentationOption(segStreamingConfig) }
      );
      pipelineRef.current = pipeline;

      if (sourceMode === 'file' && offlineInputBuffer) {
        setStatus(`Ingesting "${offlineInputBuffer.sourceLabel}"...`);
        await appendOfflineToLiveAudioBuffer(
          inputLive.bufferId,
          offlineInputBuffer.bufferId
        );
        await finalizeLiveAudioBuffer(inputLive.bufferId);

        const completion = await new Promise<
          Awaited<typeof pipeline.completed>
        >((resolve, reject) => {
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
        });

        if (completion.reason === 'stopped') {
          throw new Error(
            'Enhancement pipeline was stopped before completion.'
          );
        }

        pipelineRef.current = null;
        await finalizeEnhancementOutput(
          sampleRate,
          frameShift,
          inputLive.bufferId,
          outputLive.bufferId
        );
      } else {
        await startMicToLiveAudioBuffer(inputLive, { emitToJs: false });
        setMicRunning(true);
        setStatus(
          'Microphone active. Speak, then tap Stop to finalize enhancement.'
        );

        await new Promise<unknown>((resolve, reject) => {
          micCompletionWaiterRef.current = { resolve, reject };
          const timeoutId = setTimeout(() => {
            micCompletionWaiterRef.current = null;
            reject(
              new Error(
                `Enhancement pipeline timeout after ${PIPELINE_WAIT_TIMEOUT_MS}ms`
              )
            );
          }, PIPELINE_WAIT_TIMEOUT_MS);

          pipeline.completed.then(
            (result) => {
              clearTimeout(timeoutId);
              const waiter = micCompletionWaiterRef.current;
              micCompletionWaiterRef.current = null;
              waiter?.resolve(result);
              resolve(result);
            },
            (pipelineError) => {
              clearTimeout(timeoutId);
              const waiter = micCompletionWaiterRef.current;
              micCompletionWaiterRef.current = null;
              waiter?.reject(pipelineError);
              reject(pipelineError);
            }
          );
        });

        pipelineRef.current = null;
        setMicRunning(false);
        await finalizeEnhancementOutput(
          sampleRate,
          frameShift,
          inputLive.bufferId,
          outputLive.bufferId
        );
      }
    } catch (err) {
      setErrorSource('enhance');
      setError(formatEnhancementError(err));
      setStatus(null);
      setMicRunning(false);
      micCompletionWaiterRef.current = null;
    } finally {
      await cleanupRuntimeResources();
      setEnhancing(false);
    }
  };

  const handleStopMicEnhance = async () => {
    const inputLive = inputLiveBufferRef.current;
    if (!inputLive) return;
    setStatus('Stopping microphone and finalizing...');
    await stopMicToLiveAudioBuffer().catch(() => {});
    await finalizeLiveAudioBuffer(inputLive.bufferId).catch(() => {});
  };

  const handleReleaseAll = async () => {
    setMicRunning(false);
    micCompletionWaiterRef.current = null;
    await stopOriginalPlayback();
    await enhancedCardRef.current?.stop().catch(() => {});
    await cleanupRuntimeResources();
    await clearFinalizedOutput();
    setOfflineInputBuffer(null);
    await offlineWidgetRef.current?.clear().catch(() => {});
    await releaseEngine();
    setError(null);
    setErrorSource(null);
    setStatus(null);
  };

  const togglePlayOriginal = async () => {
    const bufferId = offlineInputBuffer?.bufferId;
    if (!bufferId) return;
    if (originalPlayerRef.current) {
      await stopOriginalPlayback();
      return;
    }
    try {
      await stopOriginalPlayback();
      await enhancedCardRef.current?.stop().catch(() => {});
      await setPipelineAudioRoutePreference({
        outputDeviceId: null,
      }).catch(() => {});
      const player = await createPcmPlayer(bufferId, {
        onEnded: () => {
          if (originalPlayerRef.current === player) {
            originalPlayerRef.current = null;
          }
          setPlayingOriginal(false);
        },
      });
      originalPlayerRef.current = player;
      setPlayingOriginal(true);
    } catch (e) {
      Alert.alert(
        'Playback failed',
        e instanceof Error ? e.message : String(e)
      );
    }
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
  const busy = enhancing || loading;
  const canRun =
    engineReady && !busy && (sourceMode === 'mic' || !!offlineInputBuffer);

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
                checkpoint to use, then stream audio below.
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
                    disabled={busy}
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
                Same file input as offline enhancement, plus microphone.
                Processing runs on a streaming pipeline with live buffers.
              </Text>

              <VoxLockReferenceAudioPicker
                key={voxLockEngineId ?? 'voxlock-ref'}
                visible={voxLockEngineId != null}
                disabled={busy}
                applyVoiceSample={applyVoxLockVoiceSample}
              />

              {engineMode === 'streaming' && (
                <SegmentationPolicyControls
                  variant="speech-streaming"
                  value={segStreamingConfig}
                  onChange={setSegStreamingConfig}
                  disabled={busy}
                />
              )}

              {engineMode === 'offline' && (
                <SegmentationPolicyControls
                  variant="speech-offline"
                  value={segStreamingConfig}
                  onChange={setSegStreamingConfig}
                  disabled={busy}
                  disableOff
                  offDisabledMessage="Live Overload requires mandatory segmentation to split audio into processable chunks."
                />
              )}

              <StreamingAudioInputSection
                sourceMode={sourceMode}
                onSourceModeChange={setSourceMode}
                audioFiles={enhancementAudioFiles}
                onBufferReady={setOfflineInputBuffer}
                onBufferReleased={() => setOfflineInputBuffer(null)}
                disabled={busy}
                widgetRef={offlineWidgetRef}
              />

              <View style={localStyles.actionRow}>
                {!micRunning ? (
                  <TouchableOpacity
                    style={[
                      styles.button,
                      localStyles.actionButton,
                      (!canRun || busy) && styles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleEnhance().catch(() => {});
                    }}
                    disabled={!canRun || busy}
                  >
                    {enhancing && !micRunning ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>
                        {sourceMode === 'mic'
                          ? 'Start enhancement'
                          : 'Run enhancement'}
                      </Text>
                    )}
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.button, localStyles.actionButton]}
                    onPress={() => {
                      handleStopMicEnhance().catch(() => {});
                    }}
                  >
                    <Text style={styles.buttonText}>Stop microphone</Text>
                  </TouchableOpacity>
                )}
              </View>

              {status ? (
                <Text style={[styles.hint, styles.mt12]}>{status}</Text>
              ) : null}

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
                        localStyles.playOriginal,
                        !offlineInputBuffer && localStyles.playDisabled,
                      ]}
                      onPress={() => {
                        togglePlayOriginal().catch(() => {});
                      }}
                      disabled={!offlineInputBuffer}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name={playingOriginal ? 'stop' : 'play'}
                          size={16}
                          style={styles.iconInline}
                        />
                        <Text style={styles.playButtonText}>
                          {playingOriginal ? 'Stop' : 'Original'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                  {lastEnhancedAudio && (
                    <View style={localStyles.enhancedCardWrap}>
                      <PipelineOfflineAudioResultCard
                        ref={enhancedCardRef}
                        bufferId={lastEnhancedAudio.outputBufferId}
                        title={`${resultPlaybackLabel} audio`}
                        sourceLabel={`${lastEnhancedAudio.numSamples.toLocaleString()} samples`}
                        sampleRate={lastEnhancedAudio.sampleRate}
                        durationMs={
                          lastEnhancedAudio.sampleRate > 0
                            ? (lastEnhancedAudio.numSamples /
                                lastEnhancedAudio.sampleRate) *
                              1000
                            : 0
                        }
                        filename={`sherpa_streaming_enhanced_${Date.now()}.wav`}
                        defaultDestinationKind="app"
                        onDismiss={() => {
                          const id = lastEnhancedAudio.outputBufferId;
                          if (finalizedOutputBufferIdRef.current === id) {
                            finalizedOutputBufferIdRef.current = null;
                          }
                          releasePipelineAudioBuffer(id)
                            .catch(() => {})
                            .finally(() => {
                              setLastEnhancedAudio(null);
                              setEnhanceResult(null);
                            });
                        }}
                        disabled={busy}
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
                disabled={busy}
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
