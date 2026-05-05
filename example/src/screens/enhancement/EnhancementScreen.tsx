import { useState, useEffect, useRef } from 'react';
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
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import {
  createEnhancement,
  detectEnhancementModel,
  type EnhancementEngine,
  type EnhancementModelType,
} from 'react-native-sherpa-onnx/enhancement';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
  getPipelineAudioBufferInfo,
} from 'react-native-sherpa-onnx/audiobuffer';
import { AudioSaveDestinationPicker } from '../../components/AudioSaveDestinationPicker';
import { formatResolvedLocation } from '../../components/audioSaveUtils';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES } from '../../audioConfig';
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
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;

function isEnhancementHint(folder: string, hint: string): boolean {
  if (hint === 'enhancement') return true;
  const n = folder.toLowerCase();
  return n.includes('gtcrn') || n.includes('dpdfnet');
}

const localStyles = StyleSheet.create({
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginBottom: 12,
  },
  optionLabel: {
    color: '#333',
    fontSize: 15,
    fontWeight: '600',
  },
  playDisabled: {
    opacity: 0.45,
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
});

export default function EnhancementScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: string; modelDir: string }>
  >([]);
  const [selectedModelKind, setSelectedModelKind] =
    useState<EnhancementModelType | null>(null);
  const [loading, setLoading] = useState(false);
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
  const [activePlaybackKind, setActivePlaybackKind] = useState<
    'original' | 'enhanced' | null
  >(null);

  const engineRef = useRef<EnhancementEngine | null>(null);
  const originalInputPlayerRef = useRef<PcmPlayer | null>(null);
  const enhancedOutputPlayerRef = useRef<PcmPlayer | null>(null);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  const stopActivePlayback = async () => {
    const original = originalInputPlayerRef.current;
    originalInputPlayerRef.current = null;
    if (original) {
      await original.destroy().catch(() => {});
    }
    const enhanced = enhancedOutputPlayerRef.current;
    enhancedOutputPlayerRef.current = null;
    if (enhanced) {
      await enhanced.destroy().catch(() => {});
    }
    setActivePlaybackKind(null);
  };

  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Enhancement) return;
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
      const o = originalInputPlayerRef.current;
      originalInputPlayerRef.current = null;
      if (o) {
        o.destroy().catch(() => {});
      }
      const p = enhancedOutputPlayerRef.current;
      enhancedOutputPlayerRef.current = null;
      if (p) {
        p.destroy().catch(() => {});
      }
    };
  }, []);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    setErrorSource(null);
    try {
      const assetModels = await listAssetModels();
      const enhancementFolders = assetModels
        .filter((m) => isEnhancementHint(m.folder, m.hint))
        .map((m) => m.folder);
      const downloadedModels = await listDownloadedModels(
        ModelCategory.Enhancement
      );
      const downloadedFolders = downloadedModels.map((model) => model.id);

      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => isEnhancementHint(m.folder, m.hint))
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch (e) {
        console.warn('EnhancementScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);

      const combined = [
        ...padFolders,
        ...enhancementFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !enhancementFolders.includes(f)
        ),
      ];
      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      setAvailableModels(combined);

      if (combined.length === 0) {
        setErrorSource('init');
        setError(
          'No speech enhancement models found. Add a GTCRN or DPDFNet model as a bundled asset, downloaded model, or PAD model. See docs/speech-enhancement.md.'
        );
      }
    } catch (err) {
      console.error('EnhancementScreen: Failed to load models:', err);
      setErrorSource('init');
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const resolveEnhancementModelPath = (modelFolder: string) => {
    if (padModelIds.includes(modelFolder)) {
      return padModelsPath
        ? getFileModelPath(
            modelFolder,
            ModelCategory.Enhancement,
            padModelsPath
          )
        : getFileModelPath(modelFolder, ModelCategory.Enhancement);
    }
    if (downloadedModelIds.includes(modelFolder)) {
      return getFileModelPath(modelFolder, ModelCategory.Enhancement);
    }
    return getAssetModelPath(modelFolder);
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelKind(null);

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }

      const modelPath = resolveEnhancementModelPath(modelFolder);
      const modelSource = await toDetectSource(modelPath);

      const engine = await createEnhancement({
        modelSource,
        numThreads: NUM_THREADS,
        modelType: 'auto',
      });

      const detectResult = await detectEnhancementModel(modelSource, {
        modelType: 'auto',
      });
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        await engine.destroy();
        engineRef.current = null;
        setErrorSource('init');
        setError('No enhancement models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
        return;
      }

      const normalized = detectResult.detectedModels.map((m) => ({
        type: m.type,
        modelDir: m.modelDir,
      }));
      const loadedKind =
        (detectResult.modelType as EnhancementModelType | undefined) ??
        (normalized[0]?.type === 'gtcrn' || normalized[0]?.type === 'dpdfnet'
          ? (normalized[0].type as EnhancementModelType)
          : null);

      engineRef.current = engine;
      setDetectedModels(normalized);
      setCurrentModelFolder(modelFolder);
      setSelectedModelForInit(modelFolder);
      if (loadedKind === 'gtcrn' || loadedKind === 'dpdfnet') {
        setSelectedModelKind(loadedKind);
      } else if (
        normalized.length === 1 &&
        (normalized[0]!.type === 'gtcrn' || normalized[0]!.type === 'dpdfnet')
      ) {
        setSelectedModelKind(normalized[0]!.type as EnhancementModelType);
      }

      const types = normalized.map((m) => m.type).join(', ');
      setInitResult(
        `Initialized: ${getModelDisplayName(modelFolder)}\nDetected: ${types}`
      );

      setEnhanceResult(null);
      setLastEnhancedAudio(null);
    } catch (err) {
      console.error('Enhancement init error:', err);
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
      setErrorSource('init');
      setError(errorMessage);
      setInitResult(`Initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  };

  const handleReinitWithKind = async (kind: EnhancementModelType) => {
    if (!currentModelFolder) return;
    setSelectedModelKind(kind);
    const folder = currentModelFolder;
    setLoading(true);
    setError(null);
    setErrorSource(null);
    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }

      const modelPath = resolveEnhancementModelPath(folder);
      const modelSource = await toDetectSource(modelPath);

      const engine = await createEnhancement({
        modelSource,
        numThreads: NUM_THREADS,
        modelType: kind,
      });
      const detectResult = await detectEnhancementModel(modelSource, {
        modelType: kind,
      });
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        await engine.destroy();
        setErrorSource('init');
        setError('No enhancement models detected for the selected type');
        return;
      }
      engineRef.current = engine;
      setInitResult(
        `Initialized: ${getModelDisplayName(folder)} (${kind.toUpperCase()})`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorSource('init');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleEnhance = async () => {
    if (!currentModelFolder) {
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
    await stopActivePlayback();

    try {
      const engine = engineRef.current;
      if (!engine) {
        setErrorSource('enhance');
        setError('Enhancement engine not initialized');
        return;
      }

      if (lastEnhancedAudio?.outputBufferId) {
        await releasePipelineAudioBuffer(
          lastEnhancedAudio.outputBufferId
        ).catch(() => {});
      }

      const sr = await engine.getSampleRate();
      // Create empty output buffer at model sample rate
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
        // Get output info for display
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
          `Segmentation: ${segConfig.mode}\nStatus: ${result.status}\nSegments: ${result.completedSegments}/${result.totalSegments}\nSkipped: ${result.skippedSegments.length}\nSamples: ${n}\nSample rate: ${outSr} Hz\nDuration: ~${sec} s\nUse “Save to” below to export a file.`
        );
      } catch (enhanceErr) {
        // Release output buffer on error (input buffer remains cached for retries)
        await releasePipelineAudioBuffer(outputBuf.bufferId).catch(() => {});
        throw enhanceErr;
      }
    } catch (err) {
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
    } finally {
      setEnhancing(false);
    }
  };

  const handleFree = async () => {
    // Release any held output buffer
    if (lastEnhancedAudio?.outputBufferId) {
      await releasePipelineAudioBuffer(lastEnhancedAudio.outputBufferId).catch(
        () => {}
      );
    }
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch (e) {
        console.warn('EnhancementScreen: destroy failed', e);
      }
    }
    engineRef.current = null;
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setDetectedModels([]);
    setSelectedModelKind(null);
    setInitResult(null);
    await offlineWidgetRef.current?.clear();
    setPreparedInputBuffer(null);
    setEnhanceResult(null);
    setLastEnhancedAudio(null);
    setError(null);
    setErrorSource(null);
    await stopActivePlayback();
  };

  const togglePlayOriginalOutput = async () => {
    const bufferId = preparedInputBuffer?.bufferId;
    if (!bufferId) return;
    if (originalInputPlayerRef.current) {
      await stopActivePlayback();
      return;
    }
    try {
      await stopActivePlayback();
      await setPipelineAudioRoutePreference({
        outputDeviceId: null,
      }).catch(() => {});
      const player = await createPcmPlayer(bufferId, {
        onEnded: () => {
          if (originalInputPlayerRef.current === player) {
            originalInputPlayerRef.current = null;
          }
          setActivePlaybackKind(null);
        },
      });
      originalInputPlayerRef.current = player;
      setActivePlaybackKind('original');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
    }
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
        outputDeviceId: null,
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

  const engineReady = currentModelFolder != null && engineRef.current != null;
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
          {currentModelFolder != null && (
            <TouchableOpacity
              style={styles.freeButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.freeButtonText}>Release model</Text>
            </TouchableOpacity>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize model</Text>
            <Text style={styles.hint}>
              Offline denoising (GTCRN / DPDFNet). Select a folder, then tap
              &quot;Use model&quot;.
            </Text>

            {(currentModelFolder || selectedModelForInit) && (
              <View style={styles.currentModelContainer}>
                <Text style={styles.currentModelText}>
                  {currentModelFolder
                    ? `Loaded: ${getModelDisplayName(currentModelFolder)}`
                    : `Selected: ${
                        selectedModelForInit
                          ? getModelDisplayName(selectedModelForInit)
                          : ''
                      }`}
                </Text>
              </View>
            )}

            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>
                  Discovering enhancement models…
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No enhancement models in assets or PAD. Add models from the
                  sherpa-onnx speech-enhancement-models release.
                </Text>
              </View>
            ) : (
              <View style={styles.modelButtons}>
                {availableModels.map((modelFolder) => {
                  const isSelected = selectedModelForInit === modelFolder;
                  const isInitialized = currentModelFolder === modelFolder;
                  return (
                    <TouchableOpacity
                      key={modelFolder}
                      style={[
                        styles.modelButton,
                        isSelected && styles.modelButtonActive,
                        isInitialized && styles.modelButtonInitialized,
                        loading && styles.buttonDisabled,
                      ]}
                      onPress={() => setSelectedModelForInit(modelFolder)}
                      disabled={loading}
                    >
                      <Text
                        style={[
                          styles.modelButtonText,
                          isSelected && styles.modelButtonTextActive,
                        ]}
                      >
                        {getModelDisplayName(modelFolder)}
                      </Text>
                      <Text style={styles.modelFolderText}>{modelFolder}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                styles.applyButton,
                loading && styles.buttonDisabled,
              ]}
              onPress={() =>
                handleInitialize(
                  selectedModelForInit ?? currentModelFolder ?? ''
                )
              }
              disabled={
                loading || (!selectedModelForInit && !currentModelFolder)
              }
            >
              {loading ? (
                <View style={styles.applyButtonContent}>
                  <ActivityIndicator
                    size="small"
                    color="#FFFFFF"
                    style={styles.applyButtonSpinner}
                  />
                  <Text style={styles.buttonText}>Initializing…</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Use model</Text>
              )}
            </TouchableOpacity>

            {initResult && !(error && errorSource === 'init') && (
              <View style={styles.resultContainer}>
                <Text style={styles.resultLabel}>Result:</Text>
                <Text style={styles.resultText}>{initResult}</Text>
              </View>
            )}

            {error && errorSource === 'init' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

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
                    onPress={() => handleReinitWithKind(kind)}
                    disabled={loading}
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

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {showKindPicker ? '3. Enhance audio' : '2. Enhance audio'}
            </Text>
            <Text style={styles.hint}>
              WAV input (example clips or a file from disk). Enhanced audio
              stays in an offline buffer until you save or play it below.
            </Text>

            {!engineReady && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Initialize an enhancement model first.
                </Text>
              </View>
            )}

            {engineReady && (
              <OfflineAudioBufferWidget
                ref={offlineWidgetRef}
                audioFiles={AUDIO_FILES}
                disabled={enhancing || loading}
                onBufferReady={(info) => {
                  setPreparedInputBuffer(info);
                  setError(null);
                  setErrorSource(null);
                }}
                onBufferReleased={() => {
                  stopActivePlayback().catch(() => {});
                  setPreparedInputBuffer(null);
                  setEnhanceResult(null);
                  setLastEnhancedAudio(null);
                }}
              />
            )}

            {engineReady && preparedInputBuffer && (
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
                      localStyles.playHalf,
                      !preparedInputBuffer && localStyles.playDisabled,
                    ]}
                    onPress={() => togglePlayOriginalOutput()}
                    disabled={!preparedInputBuffer}
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
                          : 'Enhanced'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
                {lastEnhancedAudio && (
                  <View style={styles.mt12}>
                    <AudioSaveDestinationPicker
                      audioInput={lastEnhancedAudio.outputBufferId}
                      filename={`sherpa_enhanced_${Date.now()}.wav`}
                      format="wav"
                      onSaveComplete={(result) => {
                        const location = formatResolvedLocation(result);
                        Alert.alert('Saved', `Audio saved to:\n${location}`);
                      }}
                      onError={(error) => {
                        Alert.alert('Save failed', error.message);
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
          </View>
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="Enhancement" />
    </SafeAreaView>
  );
}
