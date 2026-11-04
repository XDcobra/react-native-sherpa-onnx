import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  StyleSheet,
} from 'react-native';
import { styles } from '../stt/STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
  getPipelineAudioBufferInfo,
} from 'react-native-sherpa-onnx/audiobuffer';
import { getAudioFilesForEnhancement } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  PipelineOfflineAudioResultCard,
  type PipelineOfflineAudioResultCardHandle,
} from '../../components/PipelineOfflineAudioResultCard';
import { VoxLockReferenceAudioPicker } from '../../components/VoxLockReferenceAudioPicker';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { EnhancementModelInitPanel } from '../../components/EnhancementModelInitPanel';
import { useEnhancementModelInit } from '../../hooks/useEnhancementModelInit';
import type { RootStackParamList } from '../../types/navigation';

const localStyles = StyleSheet.create({
  playDisabled: {
    opacity: 0.45,
  },
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
  enhancedCardWrap: {
    marginTop: 12,
  },
});

export default function EnhancementScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const clearEnhanceRunState = useCallback(() => {
    setEnhanceResult(null);
    setLastEnhancedAudio(null);
  }, []);

  const enhancement = useEnhancementModelInit({
    onBeforeInit: clearEnhanceRunState,
    onEngineReady: clearEnhanceRunState,
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
  } = enhancement;

  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'init' | 'enhance' | null>(
    null
  );
  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [enhanceResult, setEnhanceResult] = useState<string | null>(null);
  const [lastEnhancedAudio, setLastEnhancedAudio] = useState<{
    outputBufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);
  const [playingOriginal, setPlayingOriginal] = useState(false);

  const originalInputPlayerRef = useRef<PcmPlayer | null>(null);
  const enhancedCardRef = useRef<PipelineOfflineAudioResultCardHandle | null>(
    null
  );
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  const stopOriginalPlayback = async () => {
    const original = originalInputPlayerRef.current;
    originalInputPlayerRef.current = null;
    if (original) {
      await original.destroy().catch(() => {});
    }
    setPlayingOriginal(false);
  };

  useEffect(() => {
    return () => {
      const o = originalInputPlayerRef.current;
      originalInputPlayerRef.current = null;
      if (o) {
        o.destroy().catch(() => {});
      }
    };
  }, []);

  const handleEnhance = async () => {
    if (!isEngineInitialized || !engineRef.current) {
      setErrorSource('enhance');
      setError('Please initialize a model first');
      return;
    }

    const prepared = preparedInputBuffer;
    if (!prepared) {
      setErrorSource('enhance');
      setError('Select audio and wait until OfflineAudioBuffer is ready');
      return;
    }

    setEnhancing(true);
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setLastEnhancedAudio(null);
    await stopOriginalPlayback();
    await enhancedCardRef.current?.stop().catch(() => {});

    try {
      const engine = engineRef.current;

      if (lastEnhancedAudio?.outputBufferId) {
        await releasePipelineAudioBuffer(
          lastEnhancedAudio.outputBufferId
        ).catch(() => {});
      }

      const sr = await engine.getSampleRate();
      const outputBuf = await createEmptyOfflineAudioBuffer(sr);
      try {
        const segOption = buildSegmentationOption(segConfig);
        const result = await engine.enhance(
          prepared.bufferId,
          outputBuf.bufferId,
          {
            segmentation: segOption,
            ...(segConfig.mode !== 'off'
              ? {
                  errorRecovery: 'partial_result' as const,
                  overlapSamples: Math.round(sr * 0.02),
                }
              : {}),
          }
        );
        const outInfo = await getPipelineAudioBufferInfo(outputBuf.bufferId);
        const n = outInfo.numSamples ?? 0;
        const outSr = outInfo.sampleRate ?? sr;
        const sec = outSr > 0 ? (n / outSr).toFixed(2) : '?';
        setLastEnhancedAudio({
          outputBufferId: outputBuf.bufferId as string,
          sampleRate: outSr,
          numSamples: n,
        });
        setEnhanceResult(
          `Segmentation: ${segConfig.mode}\nStatus: ${result.status}\nSegments: ${result.completedSegments}/${result.totalSegments}\nSkipped: ${result.skippedSegments.length}\nSamples: ${n}\nSample rate: ${outSr} Hz\nDuration: ~${sec} s\nUse the result card below to play or save.`
        );
      } catch (enhanceErr) {
        await releasePipelineAudioBuffer(outputBuf.bufferId).catch(() => {});
        throw enhanceErr;
      }
    } catch (err) {
      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${(err as { code?: string }).code}] ${errorMessage}`;
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as {
          message?: string;
          userInfo?: { NSLocalizedDescription?: string };
        };
        errorMessage =
          errorObj.message ??
          errorObj.userInfo?.NSLocalizedDescription ??
          JSON.stringify(err);
      }
      setErrorSource('enhance');
      setError(errorMessage);
    } finally {
      setEnhancing(false);
    }
  };

  const handleReleaseAll = async () => {
    if (lastEnhancedAudio?.outputBufferId) {
      await releasePipelineAudioBuffer(lastEnhancedAudio.outputBufferId).catch(
        () => {}
      );
    }
    await releaseEngine();
    await offlineWidgetRef.current?.clear();
    setPreparedInputBuffer(null);
    clearEnhanceRunState();
    setError(null);
    setErrorSource(null);
    await stopOriginalPlayback();
    await enhancedCardRef.current?.stop().catch(() => {});
  };

  const togglePlayOriginalOutput = async () => {
    const bufferId = preparedInputBuffer?.bufferId;
    if (!bufferId) return;
    if (originalInputPlayerRef.current) {
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
          if (originalInputPlayerRef.current === player) {
            originalInputPlayerRef.current = null;
          }
          setPlayingOriginal(false);
        },
      });
      originalInputPlayerRef.current = player;
      setPlayingOriginal(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
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

  const sectionEnhance = showKindPicker ? 3 : 2;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
        >
          <EnhancementModelInitPanel
            enhancement={enhancement}
            disabled={enhancing}
            onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
          />

          {showKindPicker && engineReady && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Architecture</Text>
              <Text style={styles.hint}>
                This folder contains both GTCRN and DPDFNet. Pick which
                checkpoint to use, then enhance audio below.
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
                    onPress={() => reinitWithKind(kind)}
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
                {sectionEnhance}. Enhance audio
              </Text>
              <Text style={styles.hint}>
                WAV input (example clips or a file from disk). Enhanced audio
                stays in an offline buffer until you save or play it below.
              </Text>

              <VoxLockReferenceAudioPicker
                key={voxLockEngineId ?? 'voxlock-ref'}
                visible={voxLockEngineId != null}
                disabled={enhancing || loading}
                applyVoiceSample={applyVoxLockVoiceSample}
              />

              <OfflineAudioBufferWidget
                ref={offlineWidgetRef}
                audioFiles={enhancementAudioFiles}
                disabled={enhancing || loading}
                onBufferReady={(info) => {
                  setPreparedInputBuffer(info);
                  setError(null);
                  setErrorSource(null);
                }}
                onBufferReleased={() => {
                  stopOriginalPlayback().catch(() => {});
                  enhancedCardRef.current?.stop().catch(() => {});
                  setPreparedInputBuffer(null);
                  clearEnhanceRunState();
                }}
              />

              {preparedInputBuffer && (
                <>
                  <SegmentationPolicyControls
                    variant="speech-offline"
                    value={segConfig}
                    onChange={setSegConfig}
                    disabled={enhancing || loading}
                  />
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (enhancing || loading) && styles.buttonDisabled,
                    ]}
                    onPress={handleEnhance}
                    disabled={enhancing || loading}
                  >
                    {enhancing ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>Run enhancement</Text>
                    )}
                  </TouchableOpacity>
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
                        localStyles.playOriginal,
                        !preparedInputBuffer && localStyles.playDisabled,
                      ]}
                      onPress={() => togglePlayOriginalOutput()}
                      disabled={!preparedInputBuffer}
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
                        filename={`sherpa_enhanced_${Date.now()}.wav`}
                        onDismiss={() => {
                          releasePipelineAudioBuffer(
                            lastEnhancedAudio.outputBufferId
                          )
                            .catch(() => {})
                            .finally(() => {
                              setLastEnhancedAudio(null);
                              setEnhanceResult(null);
                            });
                        }}
                        disabled={enhancing || loading}
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

      <ScreenIntroModal screenId="Enhancement" />
    </SafeAreaView>
  );
}
