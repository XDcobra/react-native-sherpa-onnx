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
} from 'react-native';
import { styles } from '../stt/STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
  resolveModelPath,
} from 'react-native-sherpa-onnx/utils';
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
  createStreamingEnhancement,
  detectEnhancementModel,
  type StreamingEnhancementEngine,
  type EnhancementPipelineHandle,
  type EnhancementModelType,
} from 'react-native-sherpa-onnx/enhancement';
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
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
import { getSegments } from 'react-native-sherpa-onnx/segment';
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
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;

type SelectedEnhancementInput = {
  source: FileSource;
  sourceType: 'example' | 'own';
  sourceLabel: string;
  sourcePathForPlayback: string;
  selectedAudioId: string | null;
  customAudioPath: string | null;
  customAudioName: string | null;
};

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

const PIPELINE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export default function EnhancementStreamingScreen() {
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
  const [outputWavPath, setOutputWavPath] = useState<string | null>(null);
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

  const engineRef = useRef<StreamingEnhancementEngine | null>(null);
  const pcmPlaybackRef = useRef<ActivePcmFilePlayback | null>(null);
  const fileIngestRef = useRef<FileIngestHandle | null>(null);
  const outputLiveBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const pipelineRef = useRef<EnhancementPipelineHandle | null>(null);
  const finalizedOutputBufferIdRef = useRef<string | null>(null);

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

  const clearFinalizedOutput = async () => {
    const existingOutputBufferId = finalizedOutputBufferIdRef.current;
    finalizedOutputBufferIdRef.current = null;
    if (existingOutputBufferId) {
      await releasePipelineAudioBuffer(existingOutputBufferId).catch(() => {});
    }
    setLastEnhancedAudio(null);
    setOutputWavPath(null);
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
        console.warn(
          'EnhancementStreamingScreen: directory picker error',
          pickerErr
        );
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
      const filename = `sherpa_streaming_enhanced_${timestamp}.wav`;
      const { directoryPath, directoryUri } = await pickSaveDirectory();

      const saveBufferToPath = async (path: string) => {
        await saveAudioAsFile(
          lastEnhancedAudio.outputBufferId,
          { kind: 'fs', path },
          'wav'
        );
      };

      if (directoryUri) {
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
      // Ignore unsupported-platform lookup failures.
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Enhancement) return;
      loadAvailableModels().catch(() => {
        // Ignore refresh errors.
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
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
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) {
        engine.destroy().catch(() => {});
      }
    };
  }, []);

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
        console.warn(
          'EnhancementStreamingScreen: PAD/listModelsAtPath failed',
          e
        );
        padFolders = [];
      }

      const resolvePathForCandidate = (modelFolder: string) => {
        if (padFolders.includes(modelFolder)) {
          return resolvedPadPath
            ? getFileModelPath(
                modelFolder,
                ModelCategory.Enhancement,
                resolvedPadPath
              )
            : getFileModelPath(modelFolder, ModelCategory.Enhancement);
        }
        if (downloadedFolders.includes(modelFolder)) {
          return getFileModelPath(modelFolder, ModelCategory.Enhancement);
        }
        return getAssetModelPath(modelFolder);
      };

      const combined = [
        ...padFolders,
        ...enhancementFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !enhancementFolders.includes(f)
        ),
      ];

      const streamingModels: string[] = [];
      for (const modelFolder of combined) {
        try {
          const detection = await detectEnhancementModel(
            await toDetectSource(resolvePathForCandidate(modelFolder)),
            { modelType: 'auto' }
          );
          if (detection.success && detection.isStreaming) {
            streamingModels.push(modelFolder);
          }
        } catch {
          // Ignore models that cannot be detected.
        }
      }

      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      setPadModelsPath(resolvedPadPath);
      setAvailableModels(streamingModels);

      if (streamingModels.length === 0) {
        setErrorSource('init');
        setError(
          'No streaming enhancement models found. Use a model that reports isStreaming=true via detectEnhancementModel.'
        );
      }
    } catch (err) {
      console.error('EnhancementStreamingScreen: Failed to load models:', err);
      setErrorSource('init');
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
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

      const detectResult = await detectEnhancementModel(
        await toDetectSource(modelPath),
        { modelType: 'auto' }
      );
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        setErrorSource('init');
        setError('No enhancement models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
        return;
      }
      if (!detectResult.isStreaming) {
        setErrorSource('init');
        setError(
          'Selected model is offline-only. Choose a model that supports streaming enhancement.'
        );
        setInitResult('Initialization failed: model is not streaming-capable');
        return;
      }

      const engine = await createStreamingEnhancement({
        modelPath,
        numThreads: NUM_THREADS,
        modelType: 'auto',
      });

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
        `Initialized streaming engine: ${getModelDisplayName(
          modelFolder
        )}\nDetected: ${types}`
      );

      setAudioSourceType(null);
      setSelectedAudio(null);
      setCustomAudioPath(null);
      setCustomAudioName(null);

      setEnhanceResult(null);
      setOutputWavPath(null);
      setLastInputPath(null);
      await clearFinalizedOutput();
    } catch (err) {
      console.error('EnhancementStreaming init error:', err);
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
    setLoading(true);
    setError(null);
    setErrorSource(null);

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }

      const modelPath = resolveEnhancementModelPath(currentModelFolder);
      const detectResult = await detectEnhancementModel(
        await toDetectSource(modelPath),
        { modelType: kind }
      );
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        setErrorSource('init');
        setError('No enhancement models detected for the selected type');
        return;
      }
      if (!detectResult.isStreaming) {
        setErrorSource('init');
        setError(
          'Selected architecture is not streaming-capable in this model directory.'
        );
        return;
      }

      const engine = await createStreamingEnhancement({
        modelPath,
        numThreads: NUM_THREADS,
        modelType: kind,
      });
      engineRef.current = engine;
      setInitResult(
        `Initialized streaming engine: ${getModelDisplayName(
          currentModelFolder
        )} (${kind.toUpperCase()})`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorSource('init');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setErrorSource(null);
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

  const handleEnhance = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ) => {
    if (!currentModelFolder) {
      setErrorSource('enhance');
      setError('Please initialize a model first');
      return;
    }

    const engine = engineRef.current;
    if (!engine) {
      setErrorSource('enhance');
      setError('Streaming enhancement engine is not initialized');
      return;
    }

    setEnhancing(true);
    setPreparingInputBuffer(true);
    setError(null);
    setErrorSource(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
    setInputBufferBuildProgress(0);
    setInputBufferBuildStatus('Preparing streaming pipeline...');

    let producedOfflineBufferId: string | null = null;

    try {
      const selectedInput = await resolveSelectedInputSource(override);
      setAudioSourceType(selectedInput.sourceType);
      setSelectedAudio(
        selectedInput.sourceType === 'example'
          ? AUDIO_FILES.find((f) => f.id === selectedInput.selectedAudioId) ??
              null
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
        'fullIfSpooled'
      );
      producedOfflineBufferId = offlineOutput.bufferId;

      const outInfo = await getPipelineAudioBufferInfo(offlineOutput.bufferId);
      const numSamples =
        outInfo.kind === 'offlinePcmBuffer' ? outInfo.numSamples : 0;
      const outputSampleRate = outInfo.sampleRate ?? sampleRate;
      const durationSeconds =
        outputSampleRate > 0 ? (numSamples / outputSampleRate).toFixed(2) : '?';

      const outputPath = `${DocumentDirectoryPath}/sherpa_streaming_enhanced_${Date.now()}.wav`;
      await saveAudioAsFile(
        offlineOutput.bufferId,
        { kind: 'fs', path: outputPath },
        'wav'
      );

      finalizedOutputBufferIdRef.current = offlineOutput.bufferId;
      setLastEnhancedAudio({
        outputBufferId: offlineOutput.bufferId,
        sampleRate: outputSampleRate,
        numSamples,
      });
      setOutputWavPath(outputPath);
      setLastInputPath(selectedInput.sourcePathForPlayback);
      setEnhanceResult(
        `Pipeline: streaming enhancement\nContinuous checkpoints: ${checkpointCount}\nFrame shift: ${frameShift} samples\nSamples: ${numSamples}\nSample rate: ${outputSampleRate} Hz\nDuration: ~${durationSeconds} s\nApp copy: ${outputPath}`
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

  const handleFree = async () => {
    setError(null);
    setErrorSource(null);

    await stopActivePlayback();
    await cleanupRuntimeResources();
    await clearFinalizedOutput();

    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch (e) {
        console.warn('EnhancementStreamingScreen: destroy failed', e);
      }
    }
    engineRef.current = null;

    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setDetectedModels([]);
    setSelectedModelKind(null);
    setInitResult(null);
    await clearPreparedInputBuffer();
    setAudioSourceType(null);
    setSelectedAudio(null);
    setCustomAudioPath(null);
    setCustomAudioName(null);
    setEnhanceResult(null);
    setOutputWavPath(null);
    setLastInputPath(null);
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
              disabled={loading || enhancing}
            >
              <Text style={styles.freeButtonText}>Release model</Text>
            </TouchableOpacity>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize model</Text>
            <Text style={styles.hint}>
              Streaming enhancement for long-form audio. Only models with
              isStreaming=true are shown here.
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
                  Discovering streaming enhancement models...
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No streaming enhancement models in assets or PAD. Add a model
                  directory that reports isStreaming=true in
                  detectEnhancementModel.
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
                      disabled={loading || enhancing}
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
                (loading || enhancing) && styles.buttonDisabled,
              ]}
              onPress={() =>
                handleInitialize(
                  selectedModelForInit ?? currentModelFolder ?? ''
                )
              }
              disabled={
                loading ||
                enhancing ||
                (!selectedModelForInit && !currentModelFolder)
              }
            >
              {loading ? (
                <View style={styles.applyButtonContent}>
                  <ActivityIndicator
                    size="small"
                    color="#FFFFFF"
                    style={styles.applyButtonSpinner}
                  />
                  <Text style={styles.buttonText}>Initializing...</Text>
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
                    onPress={() => handleReinitWithKind(kind)}
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

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {showKindPicker
                ? '3. Stream enhancement'
                : '2. Stream enhancement'}
            </Text>
            <Text style={styles.hint}>
              Same UX as offline enhancement, but processing runs as a streaming
              pipeline with live buffers to avoid offline OOM on long audio.
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
                  Initialize a streaming enhancement model first.
                </Text>
              </View>
            )}

            {engineReady && (
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segStreamingConfig}
                onChange={setSegStreamingConfig}
                disabled={enhancing || loading || preparingInputBuffer}
              />
            )}

            {engineReady &&
              (audioSourceType === 'example' || audioSourceType === 'own') &&
              (preparingInputBuffer || inputBufferBuildStatus != null) && (
                <View style={styles.decodeProgressContainer}>
                  <View style={styles.decodeProgressHeaderRow}>
                    <Text style={styles.decodeProgressLabel}>
                      {inputBufferBuildStatus ?? 'Preparing LiveAudioBuffer...'}
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

            {engineReady && !audioSourceType && (
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

                {!preparingInputBuffer && (
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
                {!preparingInputBuffer && (
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

                {!preparingInputBuffer && (
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
                        Save enhanced WAV to...
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

      <ScreenIntroModal screenId="EnhancementStreaming" />
    </SafeAreaView>
  );
}
