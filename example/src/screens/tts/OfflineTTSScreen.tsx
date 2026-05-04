import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createTTS,
  detectTtsModel,
  type TTSModelType,
  type TtsSynthesisOptions,
  type TtsSynthesisResult,
  type TtsMatchaModelOptions,
  type TtsVitsModelOptions,
} from 'react-native-sherpa-onnx/tts';
import { copyFile, shareFile } from 'react-native-sherpa-onnx/fileio';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';
import {
  createEmptyOfflineAudioBuffer,
  createOfflineAudioBufferFromFile,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import type { OfflineAudioBufferRef } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { getTtsCache, setTtsCache, clearTtsCache } from '../../engineCache';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';
import {
  DocumentDirectoryPath,
  unlink,
  exists,
} from '@dr.pogodin/react-native-fs';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { styles } from './OfflineTTSScreen.styles';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import { formatResolvedLocation } from '../../components/audioSaveUtils';
import { AudioSaveDestinationPicker } from '../../components/AudioSaveDestinationPicker';
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

/** Readable placeholder on gray `synthesisOptionInput` / `textInput` backgrounds. */
const INPUT_PLACEHOLDER_COLOR = '#8E8E93';

/** Generated audio from offline (batch) TTS — OfflineAudioBuffer pipeline. */
type GeneratedResult = {
  kind: 'buffer';
  bufferId: string;
  sampleRate: number;
  numSamples: number;
};

type ReferenceAudioState = {
  buffer: OfflineAudioBufferRef;
  sampleRate: number;
  numSamples: number;
  ownedTempPath: string | null;
};

export default function OfflineTTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: TTSModelType; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] =
    useState<TTSModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [initializingModel, setInitializingModel] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState<string>('Hello, world!');
  const [generatedAudio, setGeneratedAudio] = useState<GeneratedResult | null>(
    null
  );
  const [offlineAudioBuffers, setOfflineAudioBuffers] = useState<
    GeneratedResult[]
  >([]);
  const [generating, setGenerating] = useState(false);
  const [offlineSegConfig, setOfflineSegConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [lastSynthesisResult, setLastSynthesisResult] =
    useState<TtsSynthesisResult | null>(null);
  const [modelInfo, setModelInfo] = useState<{
    sampleRate: number;
    numSpeakers: number;
  } | null>(null);
  const [savedAudioPath, setSavedAudioPath] = useState<string | null>(null);
  const [savedAudioBufferId, setSavedAudioBufferId] = useState<string | null>(
    null
  );
  const [playingBufferId, setPlayingBufferId] = useState<string | null>(null);
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);

  const [speakerId, setSpeakerId] = useState('0');
  const [speed, setSpeed] = useState('1.0');
  const [silenceScale, setSilenceScale] = useState('');
  const [noiseScale, setNoiseScale] = useState('');
  const [noiseScaleW, setNoiseScaleW] = useState('');
  const [lengthScale, setLengthScale] = useState('');
  const [numSteps, setNumSteps] = useState('');
  const [extraOptions, setExtraOptions] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [referenceAudio, setReferenceAudio] =
    useState<ReferenceAudioState | null>(null);
  const [referenceFileName, setReferenceFileName] = useState<string | null>(
    null
  );

  const TTS_NUM_THREADS = 2;

  const getDisplayPath = (path: string) => {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  };

  const ttsEngineRef = useRef<TtsEngine | null>(null);
  const currentModelFolderRef = useRef<string | null>(null);
  const pcmPlayerRef = useRef<PcmPlayer | null>(null);
  const referenceAudioRef = useRef<ReferenceAudioState | null>(null);
  const paramsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineAudioBuffersRef = useRef<GeneratedResult[]>([]);

  const showNoiseScale = useMemo(
    () => selectedModelType === 'vits' || selectedModelType === 'matcha',
    [selectedModelType]
  );
  const showNoiseScaleW = useMemo(
    () => selectedModelType === 'vits',
    [selectedModelType]
  );
  const showLengthScale = useMemo(
    () =>
      selectedModelType === 'vits' ||
      selectedModelType === 'matcha' ||
      selectedModelType === 'kokoro' ||
      selectedModelType === 'kitten',
    [selectedModelType]
  );
  const showVoiceCloning = useMemo(
    () => selectedModelType === 'pocket' || selectedModelType === 'zipvoice',
    [selectedModelType]
  );
  const showNumSteps = useMemo(
    () => selectedModelType === 'pocket' || selectedModelType === 'zipvoice',
    [selectedModelType]
  );
  const showExtraOptions = useMemo(
    () => selectedModelType === 'pocket',
    [selectedModelType]
  );

  const refreshOutputDevices = useCallback(async () => {
    const nextOutputDevices = await fetchOutputDevices();
    setOutputDevices(nextOutputDevices);
    setSelectedOutputDeviceId((prev) =>
      keepValidDeviceSelection(prev, nextOutputDevices)
    );
  }, []);

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Tts) return;
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    refreshOutputDevices().catch(() => {
      // ignore unsupported-platform lookup failures
    });
  }, [refreshOutputDevices]);

  useEffect(() => {
    currentModelFolderRef.current = currentModelFolder;
  }, [currentModelFolder]);

  useEffect(() => {
    if (!currentModelFolder) {
      return;
    }
    if (paramsDebounceRef.current) {
      clearTimeout(paramsDebounceRef.current);
    }
    paramsDebounceRef.current = setTimeout(() => {
      const engine = ttsEngineRef.current;
      if (!engine) return;
      const noiseValue = noiseScale.trim();
      const noiseWValue = noiseScaleW.trim();
      const lengthValue = lengthScale.trim();
      const nextNoise = noiseValue.length > 0 ? parseFloat(noiseValue) : null;
      if (
        noiseValue.length > 0 &&
        (isNaN(nextNoise as number) || (nextNoise as number) <= 0)
      ) {
        setError('Invalid noise scale value');
        return;
      }
      const nextNoiseW =
        noiseWValue.length > 0 ? parseFloat(noiseWValue) : null;
      if (
        noiseWValue.length > 0 &&
        (isNaN(nextNoiseW as number) || (nextNoiseW as number) <= 0)
      ) {
        setError('Invalid noise scale W value');
        return;
      }
      const nextLength =
        lengthValue.length > 0 ? parseFloat(lengthValue) : null;
      if (
        lengthValue.length > 0 &&
        (isNaN(nextLength as number) || (nextLength as number) <= 0)
      ) {
        setError('Invalid length scale value');
        return;
      }
      if (nextNoise === null && nextNoiseW === null && nextLength === null) {
        return;
      }
      const modelType = selectedModelType ?? undefined;
      if (
        !modelType ||
        modelType === 'auto' ||
        modelType === 'zipvoice' ||
        modelType === 'pocket'
      ) {
        return;
      }
      const runUpdate = () => {
        if (modelType === 'vits') {
          const vits: TtsVitsModelOptions = {};
          if (nextNoise != null) vits.noiseScale = nextNoise;
          if (nextNoiseW != null) vits.noiseScaleW = nextNoiseW;
          if (nextLength != null) vits.lengthScale = nextLength;
          return engine.updateParams({
            modelType: 'vits',
            modelOptions: { vits },
          });
        }
        if (modelType === 'matcha') {
          const matcha: TtsMatchaModelOptions = {};
          if (nextNoise != null) matcha.noiseScale = nextNoise;
          if (nextLength != null) matcha.lengthScale = nextLength;
          return engine.updateParams({
            modelType: 'matcha',
            modelOptions: { matcha },
          });
        }
        if (modelType === 'kokoro' && nextLength != null) {
          return engine.updateParams({
            modelType: 'kokoro',
            modelOptions: { kokoro: { lengthScale: nextLength } },
          });
        }
        if (modelType === 'kitten' && nextLength != null) {
          return engine.updateParams({
            modelType: 'kitten',
            modelOptions: { kitten: { lengthScale: nextLength } },
          });
        }
        return Promise.resolve();
      };
      runUpdate().catch((err) => {
        const message =
          err instanceof Error ? err.message : 'Failed to update TTS params';
        setError(message);
      });
    }, 500);
    return () => {
      if (paramsDebounceRef.current) {
        clearTimeout(paramsDebounceRef.current);
        paramsDebounceRef.current = null;
      }
    };
  }, [
    currentModelFolder,
    lengthScale,
    noiseScale,
    noiseScaleW,
    selectedModelType,
  ]);

  // Restore persisted TTS instance when entering the screen (do not release on unmount)
  useEffect(() => {
    const cached = getTtsCache();
    if (cached.engine != null && cached.modelFolder != null) {
      ttsEngineRef.current = cached.engine;
      setCurrentModelFolder(cached.modelFolder);
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setModelInfo(cached.modelInfo);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          cached.modelFolder
        )}\nDetected models: ${cached.detectedModels
          .map((m) => m.type)
          .join(', ')}`
      );
    }
  }, []);

  const stopTtsSavedAudioPlayback = useCallback(() => {
    const player = pcmPlayerRef.current;
    if (player) {
      pcmPlayerRef.current = null;
      player.destroy().catch(() => {});
    }
    setPlayingBufferId(null);
  }, []);

  const appendOfflineAudioBuffer = useCallback((audio: GeneratedResult) => {
    setGeneratedAudio(audio);
    setOfflineAudioBuffers((prev) => {
      const next = [
        ...prev.filter((item) => item.bufferId !== audio.bufferId),
        audio,
      ];
      return next;
    });
  }, []);

  const releaseReferenceAudio = useCallback(
    async (refAudio: ReferenceAudioState | null) => {
      if (!refAudio) return;
      await releasePipelineAudioBuffer(refAudio.buffer.bufferId).catch(
        () => {}
      );
      if (refAudio.ownedTempPath) {
        await unlink(refAudio.ownedTempPath).catch(() => {});
      }
    },
    []
  );

  const clearReferenceAudio = useCallback(async () => {
    const previous = referenceAudioRef.current;
    referenceAudioRef.current = null;
    setReferenceAudio(null);
    setReferenceFileName(null);
    await releaseReferenceAudio(previous);
  }, [releaseReferenceAudio]);

  // Keep latest offline buffers accessible to the unmount cleanup callback.
  useEffect(() => {
    offlineAudioBuffersRef.current = offlineAudioBuffers;
  }, [offlineAudioBuffers]);

  // On unmount: stop saved-audio playback; do NOT destroy the batch TTS engine (it stays in cache)
  useEffect(() => {
    return () => {
      const pcmPlayer = pcmPlayerRef.current;
      if (pcmPlayer) {
        pcmPlayerRef.current = null;
        pcmPlayer.destroy().catch(() => {});
      }
      const refAudio = referenceAudioRef.current;
      referenceAudioRef.current = null;
      if (refAudio) {
        releasePipelineAudioBuffer(refAudio.buffer.bufferId).catch(() => {});
        if (refAudio.ownedTempPath) {
          unlink(refAudio.ownedTempPath).catch(() => {});
        }
      }
      const buffersToRelease = offlineAudioBuffersRef.current;
      offlineAudioBuffersRef.current = [];
      for (const item of buffersToRelease) {
        releasePipelineAudioBuffer(item.bufferId).catch(() => {});
      }
    };
  }, []);

  const handlePickReferenceWav = useCallback(async () => {
    setError(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as { fileUri?: string })?.fileUri ?? '';
      const name = file?.name ?? uri?.split('/')?.pop() ?? 'reference.wav';
      if (!uri) {
        setError('Could not get file URI from picker');
        return;
      }
      let path = uri.replace(/^file:\/\//, '');
      let ownedTempPath: string | null = null;
      if (uri.startsWith('content://')) {
        const result = await copyFile(
          { kind: 'contentUri', uri },
          { kind: 'app', base: 'cache', path: `tts_ref_${Date.now()}.wav` }
        );
        path =
          result.output.kind === 'fs' ? result.output.path : result.output.uri;
        ownedTempPath = path;
      }

      const refBuffer = await createOfflineAudioBufferFromFile({
        kind: 'fs',
        path,
      });
      const info = await getPipelineAudioBufferInfo(refBuffer.bufferId);
      const numSamples = info.numSamples ?? 0;
      if (numSamples <= 0 || info.sampleRate <= 0) {
        await releasePipelineAudioBuffer(refBuffer.bufferId).catch(() => {});
        if (ownedTempPath) {
          await unlink(ownedTempPath).catch(() => {});
        }
        setError('Reference audio is empty or invalid');
        return;
      }

      const nextRef: ReferenceAudioState = {
        buffer: refBuffer,
        sampleRate: info.sampleRate,
        numSamples,
        ownedTempPath,
      };
      const previousRef = referenceAudioRef.current;
      referenceAudioRef.current = nextRef;
      setReferenceAudio(nextRef);
      setReferenceFileName(name);
      await releaseReferenceAudio(previousRef);
    } catch (err: unknown) {
      if (
        (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
          err
        )
      )
        return;
      console.warn('Pick reference audio failed', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load reference audio'
      );
    }
  }, [releaseReferenceAudio]);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const assetModels = await listAssetModels();
      const ttsFolders = assetModels
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const downloadedModels = await listDownloadedModels(ModelCategory.Tts);
      const downloadedFolders = downloadedModels.map((model) => model.id);

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'tts')
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch (e) {
        console.warn('OfflineTTSScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);

      // Merge: PAD folders, then bundled asset folders (no duplicates)
      const combined = [
        ...padFolders,
        ...ttsFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !ttsFolders.includes(f)
        ),
      ];

      setAvailableModels(combined);
      setDownloadedModelIds(downloadedFolders);

      if (combined.length === 0) {
        setError(
          'No TTS models found. Use bundled assets, downloaded models, or PAD models. See TTS_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('OfflineTTSScreen: Failed to load models:', err);
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const resolveTtsModelPath = (modelFolder: string) => {
    if (padModelIds.includes(modelFolder)) {
      return padModelsPath
        ? getFileModelPath(modelFolder, undefined, padModelsPath)
        : getFileModelPath(modelFolder, ModelCategory.Tts);
    }
    if (downloadedModelIds.includes(modelFolder)) {
      return getFileModelPath(modelFolder, ModelCategory.Tts);
    }
    return getAssetModelPath(modelFolder);
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setInitializingModel(modelFolder);
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setModelInfo(null);
    setGeneratedAudio(null);
    setSavedAudioPath(null);
    setSavedAudioBufferId(null);
    setSpeakerId('0');
    setSpeed('1.0');
    setSilenceScale('');
    setNoiseScale('');
    setNoiseScaleW('');
    setLengthScale('');
    setNumSteps('');
    setExtraOptions('');
    setReferenceText('');
    await clearReferenceAudio();
    stopTtsSavedAudioPlayback();

    try {
      const previous = ttsEngineRef.current;
      if (previous) {
        await previous.destroy();
        ttsEngineRef.current = null;
        clearTtsCache();
      }

      const modelPath = resolveTtsModelPath(modelFolder);

      let engine: TtsEngine;
      try {
        engine = await new Promise((resolve, reject) => {
          setTimeout(() => {
            createTTS({
              modelSource: modelPath,
              numThreads: TTS_NUM_THREADS,
              debug: false,
            })
              .then(resolve)
              .catch(reject);
          }, 50);
        });
      } catch (initErr) {
        console.warn(
          'Initial createTTS failed, retrying with fewer threads',
          initErr
        );
        engine = await createTTS({
          modelSource: modelPath,
          numThreads: 1,
          debug: false,
        });
      }

      const detectResult = await detectTtsModel(
        await toDetectSource(modelPath)
      );
      const normalizedDetected =
        detectResult.success && detectResult.detectedModels?.length
          ? detectResult.detectedModels.map((m) => ({
              ...m,
              type: m.type as TTSModelType,
            }))
          : ([
              { type: 'vits' as TTSModelType, modelDir: modelFolder },
            ] as Array<{
              type: TTSModelType;
              modelDir: string;
            }>);
      const firstType =
        (detectResult.modelType as TTSModelType) ??
        normalizedDetected[0]?.type ??
        null;

      let modelInfoValue: { sampleRate: number; numSpeakers: number } | null =
        null;
      try {
        const info = await engine.getModelInfo();
        if (
          info &&
          typeof info.sampleRate === 'number' &&
          typeof info.numSpeakers === 'number'
        ) {
          modelInfoValue = {
            sampleRate: info.sampleRate,
            numSpeakers: info.numSpeakers,
          };
        }
      } catch {
        // leave modelInfoValue null
      }
      ttsEngineRef.current = engine;
      setDetectedModels(normalizedDetected);
      setCurrentModelFolder(modelFolder);
      setSelectedModelType(firstType);
      setModelInfo(modelInfoValue);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )}\nDetected models: ${normalizedDetected
          .map((m) => m.type)
          .join(', ')}`
      );
      setTtsCache(
        engine,
        modelFolder,
        normalizedDetected,
        firstType,
        modelInfoValue
      );

      setGeneratedAudio(null);
    } catch (err) {
      console.error('TTS Initialization error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
        if (err.stack) {
          console.error('Stack trace:', err.stack);
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setError(errorMessage);
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`
      );
    } finally {
      setLoading(false);
      setInitializingModel(null);
    }
  };

  const handleGenerate = async () => {
    if (!currentModelFolder) {
      setError('Please initialize a model first');
      return;
    }

    if (!selectedModelType) {
      setError('Please select a model type first');
      return;
    }

    if (!inputText.trim()) {
      setError('Please enter text to synthesize');
      return;
    }

    const hasValidRefAudioForClone =
      referenceAudio != null &&
      referenceAudio.numSamples > 0 &&
      referenceAudio.sampleRate > 0;
    if (
      selectedModelType === 'zipvoice' &&
      hasValidRefAudioForClone &&
      !referenceText.trim()
    ) {
      setError(
        'Zipvoice cloning needs a non-empty reference transcript (what the WAV says).'
      );
      return;
    }

    setGenerating(true);
    setError(null);
    setGeneratedAudio(null);
    setSavedAudioPath(null);
    setSavedAudioBufferId(null);
    setLastSynthesisResult(null);
    stopTtsSavedAudioPlayback();

    const engine = ttsEngineRef.current;
    if (!engine) {
      setError('TTS engine not initialized');
      return;
    }
    try {
      // Build synthesis options (buffer-based voice clone)
      const options: TtsSynthesisOptions = {};
      const sid = parseInt(speakerId, 10);
      if (!isNaN(sid) && sid >= 0) options.sid = sid;
      const speedValue = parseFloat(speed);
      if (!isNaN(speedValue) && speedValue > 0) options.speed = speedValue;
      const silVal = silenceScale.trim();
      if (silVal) {
        const v = parseFloat(silVal);
        if (!isNaN(v) && v > 0) options.silenceScale = v;
      }
      const stepsVal = numSteps.trim();
      if (stepsVal) {
        const v = parseInt(stepsVal, 10);
        if (!isNaN(v) && v > 0) options.numSteps = v;
      }
      if (extraOptions.trim()) {
        const ex: Record<string, string> = {};
        extraOptions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((pair) => {
            const idx = pair.indexOf(':');
            if (idx > 0) {
              const k = pair.slice(0, idx).trim();
              const v = pair.slice(idx + 1).trim();
              if (k && v) ex[k] = v;
            }
          });
        if (Object.keys(ex).length > 0) options.extra = ex;
      }

      options.segmentation = buildSegmentationOption(offlineSegConfig);

      // Voice clone: create buffer from raw reference samples
      let refAudioBuf: OfflineAudioBufferRef | undefined;
      const hasRefAudio =
        referenceAudio != null &&
        referenceAudio.numSamples > 0 &&
        referenceAudio.sampleRate > 0;
      if (
        hasRefAudio &&
        (selectedModelType === 'zipvoice' || selectedModelType === 'pocket')
      ) {
        refAudioBuf = referenceAudio.buffer;
        if (selectedModelType === 'zipvoice') {
          options.voiceClone = {
            kind: 'zipvoice',
            referenceAudio: refAudioBuf,
            referenceText: referenceText.trim(),
          };
        } else {
          const refTrim = referenceText.trim();
          options.voiceClone = {
            kind: 'pocket',
            referenceAudio: refAudioBuf,
            ...(refTrim ? { referenceText: refTrim } : {}),
          };
        }
      }

      // Buffer-to-buffer pipeline
      const sr = modelInfo?.sampleRate ?? 16000;
      const textBuf = await createOfflineTextBufferFromText(inputText);
      const audioBuf = await createEmptyOfflineAudioBuffer(sr);
      try {
        const synthesisResult = await engine.synthesize(
          textBuf,
          audioBuf,
          Object.keys(options).length > 0 ? options : undefined
        );
        setLastSynthesisResult(synthesisResult);
        const info = await getPipelineAudioBufferInfo(audioBuf.bufferId);
        appendOfflineAudioBuffer({
          kind: 'buffer',
          bufferId: audioBuf.bufferId,
          sampleRate: info.sampleRate,
          numSamples: info.numSamples ?? 0,
        });
        Alert.alert(
          'Success',
          `Generated ${info.numSamples ?? 0} samples at ${
            info.sampleRate
          } Hz (${synthesisResult.status}, ${
            synthesisResult.completedSegments
          }/${synthesisResult.totalSegments} segments)`
        );
      } finally {
        // Release text buffer (audio buffer kept for save/playback)
        await releasePipelineTextBuffer(textBuf.bufferId).catch(() => {});
      }
    } catch (err) {
      console.error('TTS Generation error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setError(errorMessage);
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveAudioComplete = (audio: GeneratedResult) => (result: any) => {
    const display = formatResolvedLocation(result);
    setSavedAudioPath(display);
    setSavedAudioBufferId(audio.bufferId);
    Alert.alert('Success', `Audio saved to:\n${display}`);
  };

  const handleToggleOfflineBufferPlayback = useCallback(
    async (bufferId: string) => {
      try {
        const currentPlayer = pcmPlayerRef.current;
        if (currentPlayer) {
          await currentPlayer.destroy().catch(() => {});
          pcmPlayerRef.current = null;
          const wasSameBuffer = playingBufferId === bufferId;
          setPlayingBufferId(null);
          if (wasSameBuffer) {
            return;
          }
        }

        await setPipelineAudioRoutePreference({
          outputDeviceId: selectedOutputDeviceId ?? null,
        }).catch(() => {});
        const player = await createPcmPlayer(bufferId, {
          onEnded: () => {
            pcmPlayerRef.current = null;
            setPlayingBufferId(null);
          },
        });
        pcmPlayerRef.current = player;
        setPlayingBufferId(bufferId);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';
        Alert.alert('Error', `Failed to play buffer: ${errorMessage}`);
      }
    },
    [playingBufferId, selectedOutputDeviceId]
  );

  const handleDeleteOfflineBuffer = useCallback(
    async (bufferId: string) => {
      if (playingBufferId === bufferId) {
        stopTtsSavedAudioPlayback();
      }

      await releasePipelineAudioBuffer(bufferId).catch(() => {});
      setOfflineAudioBuffers((prev) => {
        return prev.filter((item) => item.bufferId !== bufferId);
      });
      setGeneratedAudio((prev) => (prev?.bufferId === bufferId ? null : prev));
      if (savedAudioBufferId === bufferId) {
        setSavedAudioPath(null);
        setSavedAudioBufferId(null);
      }
    },
    [playingBufferId, savedAudioBufferId, stopTtsSavedAudioPlayback]
  );

  const handleShareAudio = async () => {
    if (!savedAudioPath) {
      Alert.alert('Error', 'No audio file saved. Save audio first.');
      return;
    }

    try {
      const existsResult = await exists(savedAudioPath);
      if (!existsResult && !savedAudioPath.startsWith('content://')) {
        Alert.alert('Error', 'Saved audio file not found.');
        return;
      }

      // We use WAV for saved files.
      const mimeType = 'audio/wav';

      const source = savedAudioPath.startsWith('content://')
        ? { kind: 'contentUri' as const, uri: savedAudioPath }
        : { kind: 'fs' as const, path: savedAudioPath };

      await shareFile(source, { mimeType });
    } catch (err) {
      console.error('Share audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', `Failed to share audio: ${errorMessage}`);
    }
  };

  const handleFree = async () => {
    try {
      stopTtsSavedAudioPlayback();
      const engine = ttsEngineRef.current;
      if (engine) {
        await engine.destroy();
        ttsEngineRef.current = null;
      }
      clearTtsCache();
      setCurrentModelFolder(null);
      setInitResult(null);
      setDetectedModels([]);
      setSelectedModelType(null);
      setModelInfo(null);
      setGeneratedAudio(null);
      const buffersToRelease = offlineAudioBuffersRef.current;
      offlineAudioBuffersRef.current = [];
      setOfflineAudioBuffers([]);
      for (const item of buffersToRelease) {
        await releasePipelineAudioBuffer(item.bufferId).catch(() => {});
      }
      setSavedAudioPath(null);
      setSavedAudioBufferId(null);
      setLastSynthesisResult(null);
      setSpeakerId('0');
      setSpeed('1.0');
      setSilenceScale('');
      setNoiseScale('');
      setNoiseScaleW('');
      setLengthScale('');
      setNumSteps('');
      setExtraOptions('');
      setReferenceText('');
      await clearReferenceAudio();
      setError(null);
      Alert.alert('Success', 'TTS model released');
    } catch (err) {
      console.error('Release error:', err);
      Alert.alert('Error', 'Failed to release TTS resources');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
        >
          {currentModelFolder != null && (
            <TouchableOpacity
              style={styles.cleanupButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.cleanupButtonText}>Release model</Text>
            </TouchableOpacity>
          )}
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="volume-high" size={48} style={styles.icon} />
            <Text style={styles.title}>Text-to-Speech (Offline)</Text>
            <Text style={styles.subtitle}>
              Batch synthesis from text — use &quot;Text-to-Speech
              (Streaming)&quot; for live incremental TTS
            </Text>
          </View>

          {/* Section 1: Initialize Model */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize TTS Model</Text>
            <Text style={styles.sectionDescription}>
              Select a TTS model to load:
            </Text>
            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color="#007AFF" />
                <Text style={styles.loadingText}>Loading models...</Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.resultContainer}>
                <Text style={styles.errorText}>
                  No TTS models found. See TTS_MODEL_SETUP.md
                </Text>
              </View>
            ) : (
              <View style={styles.buttonGroup}>
                {availableModels.map((modelFolder) => {
                  const isInitializingOther =
                    initializingModel !== null &&
                    initializingModel !== modelFolder;
                  const isDisabled =
                    isInitializingOther ||
                    (loading && initializingModel !== modelFolder);
                  return (
                    <TouchableOpacity
                      key={modelFolder}
                      style={[
                        styles.modelButton,
                        currentModelFolder === modelFolder &&
                          styles.modelButtonActive,
                        isDisabled && styles.modelButtonDisabled,
                      ]}
                      onPress={() => {
                        if (isDisabled) return;
                        handleInitialize(modelFolder);
                      }}
                      disabled={isDisabled}
                    >
                      <Text
                        style={[
                          styles.modelButtonText,
                          currentModelFolder === modelFolder &&
                            styles.modelButtonTextActive,
                          isDisabled && styles.modelButtonTextDisabled,
                        ]}
                      >
                        {getModelDisplayName(modelFolder)}
                      </Text>
                      {(() => {
                        const sizeHintInfo = getSizeHint(modelFolder);
                        const qualityHintInfo = getQualityHint(modelFolder);

                        return (
                          <View style={styles.modelHintRow}>
                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={sizeHintInfo.iconName as any}
                                size={12}
                                color={sizeHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {sizeHintInfo.tier}
                              </Text>
                            </View>

                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={qualityHintInfo.iconName as any}
                                size={12}
                                color={qualityHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {qualityHintInfo.text.split(',')[0]}
                              </Text>
                            </View>
                          </View>
                        );
                      })()}
                      <Text style={styles.modelButtonSubtext}>
                        {modelFolder}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {loading && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>Initializing model...</Text>
              </View>
            )}

            {initResult && (
              <View style={styles.resultContainer}>
                <Text style={styles.resultText}>{initResult}</Text>
              </View>
            )}
          </View>

          {/* Section 2: Select Model Type */}
          {detectedModels.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Select Model Type</Text>
              {detectedModels.length > 1 ? (
                <>
                  <Text style={styles.sectionDescription}>
                    Multiple model types detected. Select one:
                  </Text>
                  <View style={styles.detectedModelsContainer}>
                    {detectedModels.map((model) => (
                      <TouchableOpacity
                        key={model.type}
                        style={[
                          styles.detectedModelButton,
                          selectedModelType === model.type &&
                            styles.detectedModelButtonActive,
                        ]}
                        onPress={() => setSelectedModelType(model.type)}
                      >
                        <Text
                          style={[
                            styles.detectedModelButtonText,
                            selectedModelType === model.type &&
                              styles.detectedModelButtonTextActive,
                          ]}
                        >
                          {model.type}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : (
                <View style={styles.rowAlignCenter}>
                  <Ionicons
                    name="checkmark-circle"
                    size={16}
                    color="#34C759"
                    style={styles.iconInline}
                  />
                  <Text style={styles.autoSelectedText}>
                    Auto-selected: {selectedModelType}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Section 3: Model Info */}
          {modelInfo && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Model Information</Text>
              <View style={styles.infoContainer}>
                <Text style={styles.infoText}>
                  Sample Rate: {modelInfo?.sampleRate ?? 0} Hz
                </Text>
                <Text style={styles.infoText}>
                  Speakers: {modelInfo?.numSpeakers ?? 0}
                </Text>
              </View>
            </View>
          )}

          {currentModelFolder != null && selectedModelType != null && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Synthesis options</Text>
              <Text style={styles.sectionDescription}>
                Speaker / speed apply to all models. Noise &amp; length scales
                use updateParams (VITS, Matcha, Kokoro, Kitten). Voice cloning
                (Pocket / Zipvoice) is supported here via batch Generate; use
                the streaming TTS screen only for incremental synthesis without
                cloning.
              </Text>

              <Text style={styles.inputLabel}>Speaker ID:</Text>
              <TextInput
                style={styles.synthesisOptionInput}
                value={speakerId}
                onChangeText={setSpeakerId}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
              />
              <Text style={styles.inputLabel}>Speed:</Text>
              <TextInput
                style={styles.synthesisOptionInput}
                value={speed}
                onChangeText={setSpeed}
                keyboardType="decimal-pad"
                placeholder="1.0"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
              />

              {showNoiseScale && (
                <>
                  <Text style={styles.inputLabel}>Noise scale (optional):</Text>
                  <TextInput
                    style={styles.synthesisOptionInput}
                    value={noiseScale}
                    onChangeText={setNoiseScale}
                    keyboardType="decimal-pad"
                    placeholder="default"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  />
                </>
              )}
              {showNoiseScaleW && (
                <>
                  <Text style={styles.inputLabel}>
                    Noise scale W / duration (optional):
                  </Text>
                  <TextInput
                    style={styles.synthesisOptionInput}
                    value={noiseScaleW}
                    onChangeText={setNoiseScaleW}
                    keyboardType="decimal-pad"
                    placeholder="default"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  />
                </>
              )}
              {showLengthScale && (
                <>
                  <Text style={styles.inputLabel}>
                    Length scale (optional):
                  </Text>
                  <TextInput
                    style={styles.synthesisOptionInput}
                    value={lengthScale}
                    onChangeText={setLengthScale}
                    keyboardType="decimal-pad"
                    placeholder="1.0"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  />
                </>
              )}

              <Text style={styles.inputLabel}>Silence scale (optional):</Text>
              <TextInput
                style={styles.synthesisOptionInput}
                value={silenceScale}
                onChangeText={setSilenceScale}
                keyboardType="decimal-pad"
                placeholder="—"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
              />

              {showNumSteps && (
                <>
                  <Text style={styles.inputLabel}>Num steps (optional):</Text>
                  <TextInput
                    style={styles.synthesisOptionInput}
                    value={numSteps}
                    onChangeText={setNumSteps}
                    keyboardType="number-pad"
                    placeholder="—"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  />
                </>
              )}

              {showExtraOptions && (
                <>
                  <Text style={styles.inputLabel}>
                    Extra (Pocket): key:value pairs, comma-separated
                  </Text>
                  <TextInput
                    style={styles.synthesisOptionInput}
                    value={extraOptions}
                    onChangeText={setExtraOptions}
                    placeholder="temperature:0.8, chunk_size:64"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  />
                </>
              )}

              {showVoiceCloning && (
                <>
                  <Text style={styles.sectionDescription}>
                    {selectedModelType === 'zipvoice'
                      ? 'Zipvoice: 16-bit mono WAV + exact transcript required for cloning on Android.'
                      : 'Pocket: reference WAV (mono preferred). Transcript optional.'}
                  </Text>
                  <Text style={styles.inputLabel}>Reference transcript:</Text>
                  <TextInput
                    style={[
                      styles.synthesisOptionInput,
                      styles.referenceTextInput,
                    ]}
                    value={referenceText}
                    onChangeText={setReferenceText}
                    placeholder={
                      selectedModelType === 'zipvoice'
                        ? 'Required if using reference WAV…'
                        : 'Optional…'
                    }
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                    multiline
                  />
                  <Text style={styles.inputLabel}>Reference WAV:</Text>
                  {referenceAudio == null ? (
                    <TouchableOpacity
                      style={styles.streamButton}
                      onPress={handlePickReferenceWav}
                    >
                      <Text style={styles.generateButtonText}>Pick WAV…</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.resultContainer}>
                      <Text style={styles.resultText} numberOfLines={2}>
                        Loaded: {referenceFileName ?? 'reference.wav'} (
                        {referenceAudio.sampleRate} Hz,{' '}
                        {referenceAudio.numSamples} samples)
                      </Text>
                      <TouchableOpacity
                        style={styles.cancelStreamButton}
                        onPress={() => {
                          void clearReferenceAudio();
                        }}
                      >
                        <Text style={styles.generateButtonText}>
                          Clear reference
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          {/* Section 4: Generate Speech - always visible */}
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>3. Generate Speech</Text>

              <AudioDeviceDropdown
                label="Output device"
                devices={outputDevices}
                selectedDeviceId={selectedOutputDeviceId}
                onSelectDeviceId={setSelectedOutputDeviceId}
                disabled={generating}
              />

              <Text style={styles.inputLabel}>Text to Synthesize:</Text>
              <TextInput
                style={styles.textInput}
                value={inputText}
                onChangeText={setInputText}
                placeholder="Enter text to synthesize..."
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                multiline
                numberOfLines={3}
              />

              <Text style={styles.sectionDescription}>
                Segmentation: Off = one-shot; Auto = chunked synthesis per
                policy. For live text streaming and manual segment commits, use
                the Text-to-Speech (Streaming) screen.
              </Text>
              <SegmentationPolicyControls
                variant="text-offline"
                value={offlineSegConfig}
                onChange={setOfflineSegConfig}
                disabled={generating}
              />

              <View style={styles.generateActionsSpacer} />
              <TouchableOpacity
                style={[
                  styles.generateButton,
                  generating && styles.buttonDisabled,
                ]}
                onPress={handleGenerate}
                disabled={generating}
              >
                {generating ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.generateButtonText}>Generate Speech</Text>
                )}
              </TouchableOpacity>

              {lastSynthesisResult && (
                <View style={styles.resultContainer}>
                  <Text style={styles.resultText}>
                    Last offline run: {lastSynthesisResult.status}
                  </Text>
                  <Text style={styles.resultText}>
                    Segments: {lastSynthesisResult.completedSegments}/
                    {lastSynthesisResult.totalSegments}
                  </Text>
                  <Text style={styles.resultText}>
                    Processing: {lastSynthesisResult.processingTimeMs} ms
                  </Text>
                </View>
              )}
            </View>
          </>

          {/* Section 5: Results */}
          {generatedAudio && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Generated Audio</Text>
              <View style={styles.resultContainer}>
                <Text style={styles.resultText}>
                  Samples: {generatedAudio.numSamples.toLocaleString()}
                </Text>
                <Text style={styles.resultText}>
                  Sample Rate: {generatedAudio.sampleRate} Hz
                </Text>
                <Text style={styles.resultText}>
                  Duration:{' '}
                  {(
                    generatedAudio.numSamples / generatedAudio.sampleRate
                  ).toFixed(2)}{' '}
                  seconds
                </Text>
              </View>

              {/* Audio Controls — save only via shared destination picker */}
              <View style={styles.generatedAudioSaveWrap}>
                {generatedAudio && generatedAudio.numSamples > 0 && (
                  <AudioSaveDestinationPicker
                    audioInput={generatedAudio.bufferId}
                    filename={`tts_${Date.now()}.wav`}
                    format="wav"
                    defaultDestinationKind="app"
                    onSaveComplete={handleSaveAudioComplete(generatedAudio)}
                    onError={(error) => {
                      Alert.alert('Save failed', error.message);
                    }}
                  />
                )}

                {savedAudioPath && (
                  <TouchableOpacity
                    style={styles.generatedAudioShareButton}
                    onPress={handleShareAudio}
                  >
                    <View style={styles.rowAlignCenter}>
                      <Ionicons
                        name="share-social"
                        size={16}
                        color="#fff"
                        style={styles.iconInline}
                      />
                      <Text style={styles.audioButtonText}>Share</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </View>

              {savedAudioPath && (
                <Text style={styles.savedPathText}>
                  Saved: {getDisplayPath(savedAudioPath).split('/').pop()}
                  {'\n'}
                  {getDisplayPath(savedAudioPath)}
                </Text>
              )}
            </View>
          )}

          {offlineAudioBuffers.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>OfflineAudioBuffer List</Text>
              <Text style={styles.sectionDescription}>
                Active generated buffers stay available when you leave and
                re-open this screen. SDK note: you are responsible for buffer
                lifecycle management and should not forget to call
                releasePipelineAudioBuffer at the appropriate time.
              </Text>
              <View style={styles.bufferList}>
                {offlineAudioBuffers.map((buffer, index) => {
                  const isPlayingThis = playingBufferId === buffer.bufferId;
                  return (
                    <View key={buffer.bufferId} style={styles.bufferListItem}>
                      <View style={styles.bufferListHeader}>
                        <Text style={styles.bufferListTitle}>
                          Buffer {index + 1}
                        </Text>
                        <Text style={styles.bufferListMeta}>
                          {(buffer.numSamples / buffer.sampleRate).toFixed(2)}s
                        </Text>
                      </View>
                      <Text style={styles.bufferListMeta}>
                        {buffer.sampleRate} Hz |{' '}
                        {buffer.numSamples.toLocaleString()} samples
                      </Text>
                      <Text style={styles.bufferIdText} selectable>
                        {buffer.bufferId}
                      </Text>

                      <View style={styles.bufferListActions}>
                        <TouchableOpacity
                          style={[styles.bufferActionButton, styles.playButton]}
                          onPress={() => {
                            handleToggleOfflineBufferPlayback(
                              buffer.bufferId
                            ).catch(() => {});
                          }}
                        >
                          <View style={styles.rowAlignCenter}>
                            <Ionicons
                              name={isPlayingThis ? 'stop' : 'play'}
                              size={16}
                              color="#fff"
                              style={styles.iconInline}
                            />
                            <Text style={styles.audioButtonText}>
                              {isPlayingThis ? 'Stop' : 'Play'}
                            </Text>
                          </View>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[
                            styles.bufferActionButton,
                            styles.bufferDeleteButton,
                          ]}
                          onPress={() => {
                            handleDeleteOfflineBuffer(buffer.bufferId).catch(
                              () => {}
                            );
                          }}
                        >
                          <View style={styles.rowAlignCenter}>
                            <Ionicons
                              name="trash-outline"
                              size={16}
                              color="#b71c1c"
                              style={styles.iconInline}
                            />
                            <Text style={styles.bufferDeleteText}>Delete</Text>
                          </View>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Error Display */}
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Footer */}
          <View style={styles.footer}>
            <View style={styles.rowAlignCenter}>
              <Ionicons name="bulb" size={16} style={styles.iconInline} />
              <Text style={styles.footerText}>
                Tip: Models must be placed in assets/models/ directory
              </Text>
            </View>
          </View>
        </ScrollView>
      </View>
      <ScreenIntroModal screenId="TTS" />
    </SafeAreaView>
  );
}
