import { useState, useEffect, useRef } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
  StyleSheet,
  Switch,
} from 'react-native';
import { styles } from '../stt/STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  resolveModelPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  DocumentDirectoryPath,
  DownloadDirectoryPath,
  mkdir,
} from '@dr.pogodin/react-native-fs';
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
  createOfflineAudioBufferFromFile,
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
  getPipelineAudioBufferInfo,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES, type AudioFileInfo } from '../../audioConfig';
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

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;

type PreparedEnhancementInputBuffer = {
  bufferId: string;
  sourceType: 'example' | 'own';
  sourceLabel: string;
  sourcePathForPlayback: string;
  selectedAudioId: string | null;
  customAudioPath: string | null;
  customAudioName: string | null;
};

let gEnhancementPreparedInputBuffer: PreparedEnhancementInputBuffer | null =
  null;

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
  const [audioSourceType, setAudioSourceType] = useState<
    'example' | 'own' | null
  >(gEnhancementPreparedInputBuffer?.sourceType ?? null);
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(
    () => {
      const selectedId = gEnhancementPreparedInputBuffer?.selectedAudioId;
      if (!selectedId) return null;
      return AUDIO_FILES.find((file) => file.id === selectedId) ?? null;
    }
  );
  const [customAudioPath, setCustomAudioPath] = useState<string | null>(
    gEnhancementPreparedInputBuffer?.customAudioPath ?? null
  );
  const [customAudioName, setCustomAudioName] = useState<string | null>(
    gEnhancementPreparedInputBuffer?.customAudioName ?? null
  );
  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<PreparedEnhancementInputBuffer | null>(
      gEnhancementPreparedInputBuffer
    );
  const [preparingInputBuffer, setPreparingInputBuffer] = useState(false);
  const [inputBufferBuildProgress, setInputBufferBuildProgress] = useState<
    number | null
  >(null);
  const [inputBufferBuildStatus, setInputBufferBuildStatus] = useState<
    string | null
  >(null);
  const [enhancing, setEnhancing] = useState(false);
  const [useSegmentedEnhancement, setUseSegmentedEnhancement] = useState(false);
  const [enhanceResult, setEnhanceResult] = useState<string | null>(null);
  const [outputWavPath, setOutputWavPath] = useState<string | null>(null);
  /** Path of the input file used for the last successful run (for playback). */
  const [lastInputPath, setLastInputPath] = useState<string | null>(null);
  const [lastEnhancedAudio, setLastEnhancedAudio] = useState<{
    outputBufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);

  const engineRef = useRef<EnhancementEngine | null>(null);
  const pcmPlaybackRef = useRef<ActivePcmFilePlayback | null>(null);
  const preparedInputBufferRef = useRef<PreparedEnhancementInputBuffer | null>(
    gEnhancementPreparedInputBuffer
  );
  const inputBufferRequestRef = useRef(0);

  const setPreparedInputBufferState = (
    next: PreparedEnhancementInputBuffer | null
  ) => {
    gEnhancementPreparedInputBuffer = next;
    preparedInputBufferRef.current = next;
    setPreparedInputBuffer(next);
  };

  const getDisplayPath = (path: string) => {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  };

  const stopActivePlayback = async () => {
    if (!pcmPlaybackRef.current) return;
    const activePlayback = pcmPlaybackRef.current;
    pcmPlaybackRef.current = null;
    await stopPcmFilePlayback(activePlayback);
  };

  const refreshOutputDevices = async () => {
    const nextOutputDevices = await fetchOutputDevices();
    setOutputDevices(nextOutputDevices);
    setSelectedOutputDeviceId((prev) =>
      keepValidDeviceSelection(prev, nextOutputDevices)
    );
  };

  const clearPreparedInputBuffer = async () => {
    inputBufferRequestRef.current += 1;
    const existing = preparedInputBufferRef.current;
    setPreparedInputBufferState(null);
    setPreparingInputBuffer(false);
    setInputBufferBuildProgress(null);
    setInputBufferBuildStatus(null);
    if (existing?.bufferId) {
      await releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
    }
  };

  const handleRemovePreparedInputBuffer = async () => {
    await clearPreparedInputBuffer();
    setAudioSourceType(null);
    setSelectedAudio(null);
    setCustomAudioPath(null);
    setCustomAudioName(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setLastEnhancedAudio(null);
  };

  const resolveSelectedInputSource = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ): Promise<{
    source: FileSource;
    sourceType: 'example' | 'own';
    sourceLabel: string;
    sourcePathForPlayback: string;
    selectedAudioId: string | null;
    customAudioPath: string | null;
    customAudioName: string | null;
  }> => {
    const effectiveCustomAudioPath =
      override?.customAudioPath ?? customAudioPath;
    const effectiveCustomAudioName =
      override?.customAudioName ?? customAudioName;
    const effectiveSelectedAudio = override?.selectedAudio ?? selectedAudio;

    if (effectiveCustomAudioPath) {
      const trimmed = effectiveCustomAudioPath.trim();
      if (trimmed.startsWith('content://')) {
        return {
          source: { kind: 'contentUri', uri: trimmed },
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
      const audioPathConfig = autoModelPath(effectiveSelectedAudio.id);
      const resolvedPath = await resolveModelPath(audioPathConfig);
      return {
        source: { kind: 'fs', path: resolvedPath },
        sourceType: 'example',
        sourceLabel: effectiveSelectedAudio.name,
        sourcePathForPlayback: resolvedPath,
        selectedAudioId: effectiveSelectedAudio.id,
        customAudioPath: null,
        customAudioName: null,
      };
    }

    throw new Error('Select example audio or a local WAV file');
  };

  const prepareInputBufferFromSelection = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ) => {
    const requestId = ++inputBufferRequestRef.current;

    setPreparingInputBuffer(true);
    setInputBufferBuildProgress(0);
    setInputBufferBuildStatus('Preparing OfflineAudioBuffer...');
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setLastEnhancedAudio(null);

    try {
      const resolved = await resolveSelectedInputSource(override);
      if (requestId !== inputBufferRequestRef.current) {
        return;
      }

      setAudioSourceType(resolved.sourceType);
      setSelectedAudio(
        resolved.sourceType === 'example'
          ? AUDIO_FILES.find((file) => file.id === resolved.selectedAudioId) ??
              null
          : null
      );
      setCustomAudioPath(resolved.customAudioPath);
      setCustomAudioName(resolved.customAudioName);

      const existing = preparedInputBufferRef.current;
      setPreparedInputBufferState(null);
      if (existing?.bufferId) {
        await releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
      }

      setInputBufferBuildStatus(
        `Decoding \"${resolved.sourceLabel}\" into OfflineAudioBuffer...`
      );

      const inputRef = await createOfflineAudioBufferFromFile(resolved.source, {
        onProgress: (event) => {
          if (requestId !== inputBufferRequestRef.current) {
            return;
          }

          const percent = Math.max(0, Math.min(100, event.percent ?? 0));
          setInputBufferBuildProgress(percent);

          const totalFrames = event.totalFramesEstimate ?? 0;
          if (totalFrames > 0) {
            setInputBufferBuildStatus(
              `Decoding \"${resolved.sourceLabel}\"... ${Math.round(
                percent
              )}% (${event.framesDecoded}/${totalFrames} frames)`
            );
            return;
          }

          setInputBufferBuildStatus(
            `Decoding \"${resolved.sourceLabel}\"... ${Math.round(percent)}%`
          );
        },
      });

      if (requestId !== inputBufferRequestRef.current) {
        await releasePipelineAudioBuffer(inputRef.bufferId).catch(() => {});
        return;
      }

      setPreparedInputBufferState({
        bufferId: inputRef.bufferId,
        sourceType: resolved.sourceType,
        sourceLabel: resolved.sourceLabel,
        sourcePathForPlayback: resolved.sourcePathForPlayback,
        selectedAudioId: resolved.selectedAudioId,
        customAudioPath: resolved.customAudioPath,
        customAudioName: resolved.customAudioName,
      });
      setInputBufferBuildProgress(null);
      setInputBufferBuildStatus(null);
    } catch (err) {
      if (requestId !== inputBufferRequestRef.current) {
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      setErrorSource('enhance');
      setError(msg);
      setInputBufferBuildProgress(null);
      setInputBufferBuildStatus(null);
    } finally {
      if (requestId === inputBufferRequestRef.current) {
        setPreparingInputBuffer(false);
      }
    }
  };

  const pickSaveDirectory = async (): Promise<{
    directoryPath: string | null;
    directoryUri: string | null;
  }> => {
    let directoryPath: string | null = null;
    let directoryUri: string | null = null;
    try {
      const picked = await DocumentPicker.pickDirectory();
      if (picked?.uri) {
        if (picked.uri.startsWith('file://')) {
          directoryPath = decodeURI(picked.uri.replace('file://', ''));
        } else if (picked.uri.startsWith('content://')) {
          directoryUri = picked.uri;
        }
      }
    } catch (pickerErr) {
      const isCancel = (DocumentPicker as any).isCancel?.(pickerErr);
      if (!isCancel) {
        console.warn('EnhancementScreen: directory picker error', pickerErr);
      }
    }
    return { directoryPath, directoryUri };
  };

  const getFallbackDirectory = () => {
    if (Platform.OS === 'android' && DownloadDirectoryPath) {
      return DownloadDirectoryPath;
    }
    return DocumentDirectoryPath;
  };

  const handleSaveEnhanced = async () => {
    if (!lastEnhancedAudio?.outputBufferId) {
      Alert.alert('Error', 'No enhanced audio to save. Run enhancement first.');
      return;
    }
    setSaving(true);
    try {
      const timestamp = Date.now();
      const filename = `sherpa_enhanced_${timestamp}.wav`;
      const { directoryPath, directoryUri } = await pickSaveDirectory();

      const saveBufferToPath = async (path: string) => {
        await saveAudioAsFile(
          lastEnhancedAudio.outputBufferId,
          { kind: 'fs', path },
          'wav'
        );
      };

      if (directoryUri) {
        // Android SAF: save to cache then copy
        const tmpPath = `${DocumentDirectoryPath}/${filename}`;
        await saveBufferToPath(tmpPath);
        Alert.alert('Saved', `Audio saved to:\n${getDisplayPath(tmpPath)}`);
        return;
      }

      const targetDirectory = directoryPath ?? getFallbackDirectory();
      if (!directoryPath) {
        Alert.alert(
          'Notice',
          'No folder was selected. Saving to the app default directory.'
        );
      }
      await mkdir(targetDirectory);
      const filePath = `${targetDirectory}/${filename}`;
      await saveBufferToPath(filePath);
      Alert.alert('Saved', `Audio saved to:\n${getDisplayPath(filePath)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Save failed', msg);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    loadAvailableModels();
    refreshOutputDevices().catch(() => {
      // ignore unsupported-platform lookup failures
    });
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
      inputBufferRequestRef.current += 1;
      if (pcmPlaybackRef.current) {
        stopPcmFilePlayback(pcmPlaybackRef.current).catch(() => {});
        pcmPlaybackRef.current = null;
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

      const engine = await createEnhancement({
        modelPath,
        numThreads: NUM_THREADS,
        modelType: 'auto',
      });

      const detectResult = await detectEnhancementModel(
        await toDetectSource(modelPath),
        { modelType: 'auto' }
      );
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

      const persistedPrepared = preparedInputBufferRef.current;
      if (persistedPrepared) {
        setAudioSourceType(persistedPrepared.sourceType);
        setSelectedAudio(
          persistedPrepared.selectedAudioId
            ? AUDIO_FILES.find(
                (file) => file.id === persistedPrepared.selectedAudioId
              ) ?? null
            : null
        );
        setCustomAudioPath(persistedPrepared.customAudioPath);
        setCustomAudioName(persistedPrepared.customAudioName);
      } else {
        setAudioSourceType(null);
        setSelectedAudio(null);
        setCustomAudioPath(null);
        setCustomAudioName(null);
      }
      setEnhanceResult(null);
      setOutputWavPath(null);
      setLastInputPath(null);
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

      const engine = await createEnhancement({
        modelPath,
        numThreads: NUM_THREADS,
        modelType: kind,
      });
      const detectResult = await detectEnhancementModel(
        await toDetectSource(modelPath),
        { modelType: kind }
      );
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
    if (preparingInputBuffer) {
      setErrorSource('enhance');
      setError('Please wait for OfflineAudioBuffer preparation to finish');
      return;
    }

    const prepared = preparedInputBufferRef.current;
    if (!prepared) {
      setErrorSource('enhance');
      setError('Select audio and wait until OfflineAudioBuffer is ready');
      return;
    }

    setEnhancing(true);
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setLastEnhancedAudio(null);

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
        const result = await engine.enhance(
          prepared.bufferId,
          outputBuf.bufferId,
          useSegmentedEnhancement
            ? {
                segmentation: { mode: 'auto' },
                errorRecovery: 'partial_result',
                overlapSamples: Math.round(sr * 0.02),
              }
            : undefined
        );
        // Get output info for display
        const outInfo = await getPipelineAudioBufferInfo(outputBuf.bufferId);
        const n = outInfo.numSamples ?? 0;
        const outSr = outInfo.sampleRate ?? sr;
        const sec = outSr > 0 ? (n / outSr).toFixed(2) : '?';
        const outPath = `${DocumentDirectoryPath}/sherpa_enhanced_${Date.now()}.wav`;
        await saveAudioAsFile(
          outputBuf.bufferId,
          { kind: 'fs', path: outPath },
          'wav'
        );
        setOutputWavPath(outPath);
        setLastInputPath(prepared.sourcePathForPlayback);
        setLastEnhancedAudio({
          outputBufferId: outputBuf.bufferId as string,
          sampleRate: outSr,
          numSamples: n,
        });
        setEnhanceResult(
          `Mode: ${
            useSegmentedEnhancement ? 'segmented' : 'single-shot'
          }\nStatus: ${result.status}\nSegments: ${result.completedSegments}/${
            result.totalSegments
          }\nSkipped: ${
            result.skippedSegments.length
          }\nSamples: ${n}\nSample rate: ${outSr} Hz\nDuration: ~${sec} s\nApp copy: ${outPath}`
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
    setAudioSourceType(null);
    setSelectedAudio(null);
    setCustomAudioPath(null);
    setCustomAudioName(null);
    await clearPreparedInputBuffer();
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setLastEnhancedAudio(null);
    setError(null);
    setErrorSource(null);
    await stopActivePlayback();
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setLastEnhancedAudio(null);
    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(res) ? res[0] : res;
      const uri =
        file.uri ??
        (file as any).fileCopyUri ??
        (file as any).localUri ??
        (file as any).nativeUri;
      const name = file.name || uri?.split('/')?.pop() || 'local.wav';
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
      await prepareInputBufferFromSelection({
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

  const playPath = async (path: string | null) => {
    if (!path) return;
    try {
      await stopActivePlayback();
      let nextPlayback: ActivePcmFilePlayback | null = null;
      nextPlayback = await startPcmFilePlayback(
        path,
        () => {
          if (pcmPlaybackRef.current === nextPlayback) {
            pcmPlaybackRef.current = null;
          }
        },
        {
          outputDeviceId: selectedOutputDeviceId ?? undefined,
        }
      );
      pcmPlaybackRef.current = nextPlayback;
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
              WAV input (example clips or a file from disk). Output is float32
              WAV under the app documents directory.
            </Text>

            <AudioDeviceDropdown
              label="Output device"
              devices={outputDevices}
              selectedDeviceId={selectedOutputDeviceId}
              onSelectDeviceId={setSelectedOutputDeviceId}
              disabled={enhancing || loading || preparingInputBuffer}
            />

            {!engineReady && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Initialize an enhancement model first.
                </Text>
              </View>
            )}

            {engineReady &&
              (audioSourceType === 'example' || audioSourceType === 'own') &&
              (preparingInputBuffer || inputBufferBuildStatus != null) && (
                <View style={styles.decodeProgressContainer}>
                  <View style={styles.decodeProgressHeaderRow}>
                    <Text style={styles.decodeProgressLabel}>
                      {inputBufferBuildStatus ??
                        'Preparing OfflineAudioBuffer...'}
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
                  {preparingInputBuffer && (
                    <Text style={styles.decodeProgressMeta}>
                      Large files can take a while to decode.
                    </Text>
                  )}
                </View>
              )}

            {preparedInputBuffer && (
              <View style={styles.selectedFileContainer}>
                <View style={styles.bufferHeaderRow}>
                  <View style={styles.bufferHeaderTextWrap}>
                    <Text style={styles.selectedFileLabel}>
                      OfflineAudioBuffer ready:
                    </Text>
                    <Text style={styles.selectedFileName}>
                      {preparedInputBuffer.sourceLabel}
                    </Text>
                    <Text style={styles.bufferIdText} selectable>
                      {preparedInputBuffer.bufferId}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.bufferDeleteButton}
                    onPress={() => {
                      handleRemovePreparedInputBuffer().catch(() => {});
                    }}
                    disabled={loading || enhancing || preparingInputBuffer}
                  >
                    <Ionicons name="trash-outline" size={18} color="#b71c1c" />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {engineReady && !audioSourceType && !preparedInputBuffer && (
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

            {engineReady && audioSourceType === 'example' && (
              <>
                <Text style={styles.subsectionTitle}>Select clip</Text>
                <View style={styles.audioFilesContainer}>
                  {AUDIO_FILES.map((audioFile) => (
                    <TouchableOpacity
                      key={audioFile.id}
                      style={[
                        styles.audioFileButton,
                        selectedAudio?.id === audioFile.id &&
                          styles.audioFileButtonActive,
                      ]}
                      onPress={() => {
                        prepareInputBufferFromSelection({
                          selectedAudio: audioFile,
                        }).catch(() => {});
                      }}
                      disabled={
                        enhancing ||
                        loading ||
                        preparingInputBuffer ||
                        preparedInputBuffer != null
                      }
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
                {preparedInputBuffer?.sourceType === 'example' && (
                  <>
                    <View style={localStyles.optionRow}>
                      <Text style={localStyles.optionLabel}>
                        Segmented offline
                      </Text>
                      <Switch
                        value={useSegmentedEnhancement}
                        onValueChange={setUseSegmentedEnhancement}
                        disabled={enhancing || loading || preparingInputBuffer}
                      />
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.button,
                        (enhancing || loading || preparingInputBuffer) &&
                          styles.buttonDisabled,
                      ]}
                      onPress={handleEnhance}
                      disabled={enhancing || loading || preparingInputBuffer}
                    >
                      {enhancing ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.buttonText}>Run enhancement</Text>
                      )}
                    </TouchableOpacity>
                  </>
                )}
                {!preparingInputBuffer && !preparedInputBuffer && (
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.mt15]}
                    onPress={() => {
                      setAudioSourceType(null);
                      setSelectedAudio(null);
                      clearPreparedInputBuffer().catch(() => {});
                      setEnhanceResult(null);
                      setOutputWavPath(null);
                      setLastInputPath(null);
                      setLastEnhancedAudio(null);
                    }}
                    disabled={preparingInputBuffer}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {'<- Change audio source'}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            {engineReady && audioSourceType === 'own' && (
              <>
                <Text style={styles.subsectionTitle}>Local WAV</Text>
                {!preparingInputBuffer && !preparedInputBuffer && (
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (loading || preparingInputBuffer || enhancing) &&
                        styles.buttonDisabled,
                    ]}
                    onPress={handlePickLocalFile}
                    disabled={loading || preparingInputBuffer || enhancing}
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
                      onPress={() => playPath(customAudioPath)}
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
                {preparedInputBuffer?.sourceType === 'own' && (
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (enhancing || loading || preparingInputBuffer) &&
                        styles.buttonDisabled,
                      styles.mt12,
                    ]}
                    onPress={handleEnhance}
                    disabled={enhancing || loading || preparingInputBuffer}
                  >
                    {enhancing ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>Run enhancement</Text>
                    )}
                  </TouchableOpacity>
                )}
                {!preparingInputBuffer && !preparedInputBuffer && (
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.mt15]}
                    onPress={() => {
                      setAudioSourceType(null);
                      setCustomAudioPath(null);
                      setCustomAudioName(null);
                      clearPreparedInputBuffer().catch(() => {});
                      setEnhanceResult(null);
                      setOutputWavPath(null);
                      setLastInputPath(null);
                      setLastEnhancedAudio(null);
                    }}
                    disabled={preparingInputBuffer}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {'<- Change audio source'}
                    </Text>
                  </TouchableOpacity>
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
                    onPress={() => playPath(lastInputPath)}
                    disabled={!lastInputPath}
                  >
                    <View style={styles.rowAlignCenter}>
                      <Ionicons
                        name="play"
                        size={16}
                        style={styles.iconInline}
                      />
                      <Text style={styles.playButtonText}>Original</Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.playButton,
                      localStyles.playHalf,
                      !outputWavPath && localStyles.playDisabled,
                    ]}
                    onPress={() => playPath(outputWavPath)}
                    disabled={!outputWavPath}
                  >
                    <View style={styles.rowAlignCenter}>
                      <Ionicons
                        name="play"
                        size={16}
                        style={styles.iconInline}
                      />
                      <Text style={styles.playButtonText}>Enhanced</Text>
                    </View>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={[
                    styles.secondaryButton,
                    styles.mt12,
                    (saving || !lastEnhancedAudio) && styles.buttonDisabled,
                  ]}
                  onPress={handleSaveEnhanced}
                  disabled={saving || !lastEnhancedAudio}
                >
                  {saving ? (
                    <ActivityIndicator color="#666" />
                  ) : (
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="save-outline"
                        size={18}
                        color="#666"
                        style={styles.iconInline}
                      />
                      <Text style={styles.secondaryButtonText}>
                        Save enhanced WAV to…
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
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
