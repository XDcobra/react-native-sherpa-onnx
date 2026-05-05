import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import * as DocumentPicker from '@react-native-documents/picker';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
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
import {
  createStreamingSTT,
  detectSttModel,
  type LiveSttEngine,
  type SttPipelineHandle,
} from 'react-native-sherpa-onnx/stt';
import {
  createStreamingTTS,
  detectTtsModel,
  type StreamingTtsEngine,
  type TtsPipelineHandle,
} from 'react-native-sherpa-onnx/tts';
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
  appendLiveTextSegment,
  createLiveTextBuffer,
  finalizeLiveTextBuffer,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import { appendPartial } from 'react-native-sherpa-onnx/segment';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { styles } from './LivePipelineShowcaseScreen.styles';

const STT_INPUT_SAMPLE_RATE = 16000;
const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;
const MAX_SEGMENT_EVENTS = 20;

type PipelineState = 'idle' | 'starting' | 'running' | 'stopping';
type SourceMode = 'mic' | 'file';

type PipelineStep = 'input' | 'stt' | 'tts' | 'play';

type SegmentEvent = {
  index: number;
  text: string;
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

function toFileSource(uri: string): FileSource {
  const v = uri.trim();
  if (v.startsWith('content://')) return { kind: 'contentUri', uri: v };
  if (v.startsWith('file://'))
    return { kind: 'fs', path: decodeURI(v.replace(/^file:\/\//, '')) };
  return { kind: 'fs', path: v };
}

export default function LivePipelineShowcaseScreen() {
  // ── model lists ────────────────────────────────────────────────────────────
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [ttsModels, setTtsModels] = useState<string[]>([]);
  const [sttPadIds, setSttPadIds] = useState<string[]>([]);
  const [ttsPadIds, setTtsPadIds] = useState<string[]>([]);
  const [sttPadPath, setSttPadPath] = useState<string | null>(null);
  const [ttsPadPath, setTtsPadPath] = useState<string | null>(null);
  const [sttDownloadedIds, setSttDownloadedIds] = useState<string[]>([]);
  const [ttsDownloadedIds, setTtsDownloadedIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // ── selection ──────────────────────────────────────────────────────────────
  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [selectedSttModel, setSelectedSttModel] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [pickedFileUri, setPickedFileUri] = useState<string | null>(null);
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);
  const [textSegConfig, setTextSegConfig] = useState<SegmentationControlConfig>(
    { mode: 'off' }
  );

  // ── pipeline state ─────────────────────────────────────────────────────────
  const [pipelineState, setPipelineState] = useState<PipelineState>('idle');
  const [activeSteps, setActiveSteps] = useState<Set<PipelineStep>>(new Set());
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState('');
  const [committedSegments, setCommittedSegments] = useState<string[]>([]);
  const [segmentEvents, setSegmentEvents] = useState<SegmentEvent[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // ── refs ───────────────────────────────────────────────────────────────────
  const sttEngineRef = useRef<LiveSttEngine | null>(null);
  const ttsEngineRef = useRef<StreamingTtsEngine | null>(null);
  const sttInputAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const ttsOutputAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const sttOutputTextRef = useRef<LiveTextBufferRef | null>(null);
  const ttsInputTextRef = useRef<LiveTextBufferRef | null>(null);
  const sttPipelineRef = useRef<SttPipelineHandle | null>(null);
  const ttsPipelineRef = useRef<TtsPipelineHandle | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const ingestRef = useRef<FileIngestHandle | null>(null);
  const segCountRef = useRef(0);

  // ── load model lists ───────────────────────────────────────────────────────
  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
      const fallbackPath = `${DocumentDirectoryPath}/models`;
      const padPath = padPathFromNative ?? fallbackPath;

      const allAsset = await listAssetModels();
      const assetSttIds = allAsset
        .filter((m) => m.hint === 'stt')
        .map((m) => m.folder);
      const assetTtsIds = allAsset
        .filter((m) => m.hint === 'tts')
        .map((m) => m.folder);

      const [sttDl, ttsDl] = await Promise.all([
        listDownloadedModels(ModelCategory.Stt).then((r) => r.map((m) => m.id)),
        listDownloadedModels(ModelCategory.Tts).then((r) => r.map((m) => m.id)),
      ]);

      const padResults = await listModelsAtPath(padPath).catch(() => []);
      const padSttIds = padResults
        .filter((m) => m.hint === 'stt')
        .map((m) => m.folder);
      const padTtsIds = padResults
        .filter((m) => m.hint === 'tts')
        .map((m) => m.folder);

      const sttFilePath = `${DocumentDirectoryPath}/sherpa-onnx/models/${ModelCategory.Stt}`;
      const ttsFilePath = `${DocumentDirectoryPath}/sherpa-onnx/models/${ModelCategory.Tts}`;
      const [sttFs, ttsFs] = await Promise.all([
        listModelsAtPath(sttFilePath).catch(() => []),
        listModelsAtPath(ttsFilePath).catch(() => []),
      ]);

      const sttFsIds = sttFs.map((m) => m.folder);
      const ttsFsIds = ttsFs.map((m) => m.folder);
      const sttCandidates = [
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
      const ttsCandidates = [
        ...padTtsIds,
        ...assetTtsIds.filter((f) => !padTtsIds.includes(f)),
        ...ttsDl.filter(
          (f) => !padTtsIds.includes(f) && !assetTtsIds.includes(f)
        ),
        ...ttsFsIds.filter(
          (f) =>
            !padTtsIds.includes(f) &&
            !assetTtsIds.includes(f) &&
            !ttsDl.includes(f)
        ),
      ];
      const sttPadSet = new Set(padSttIds);
      const ttsPadSet = new Set(padTtsIds);
      const sttAssetSet = new Set(assetSttIds);
      const ttsAssetSet = new Set(assetTtsIds);

      const streamingSttRaw = await Promise.all(
        sttCandidates.map(async (folder) => {
          try {
            const source = sttPadSet.has(folder)
              ? getFileModelPath(folder, ModelCategory.Stt, padPath)
              : sttAssetSet.has(folder)
              ? getAssetModelPath(folder)
              : getFileModelPath(folder, ModelCategory.Stt);
            const detected = await detectSttModel(
              await toDetectSource(source),
              {
                modelType: 'auto',
              }
            );
            return detected.success && detected.isStreaming ? folder : null;
          } catch {
            return null;
          }
        })
      );

      const validTtsRaw = await Promise.all(
        ttsCandidates.map(async (folder) => {
          try {
            const source = ttsPadSet.has(folder)
              ? getFileModelPath(folder, ModelCategory.Tts, padPath)
              : ttsAssetSet.has(folder)
              ? getAssetModelPath(folder)
              : getFileModelPath(folder, ModelCategory.Tts);
            const detected = await detectTtsModel(
              await toDetectSource(source),
              {
                modelType: 'auto',
              }
            );
            return detected.success ? folder : null;
          } catch {
            return null;
          }
        })
      );

      const streamingSttModels = streamingSttRaw.filter(
        (m): m is string => m != null
      );
      const validTtsModels = validTtsRaw.filter((m): m is string => m != null);
      const effectiveSttModels =
        streamingSttModels.length > 0 ? streamingSttModels : sttCandidates;
      const effectiveTtsModels =
        validTtsModels.length > 0 ? validTtsModels : ttsCandidates;

      setSttPadIds(padSttIds);
      setTtsPadIds(padTtsIds);
      setSttPadPath(padSttIds.length > 0 ? padPath : null);
      setTtsPadPath(padTtsIds.length > 0 ? padPath : null);
      setSttDownloadedIds([...new Set([...sttDl, ...sttFsIds, ...padSttIds])]);
      setTtsDownloadedIds([...new Set([...ttsDl, ...ttsFsIds, ...padTtsIds])]);
      setSttModels(effectiveSttModels);
      setTtsModels(effectiveTtsModels);
      setSelectedSttModel((prev) =>
        prev && effectiveSttModels.includes(prev)
          ? prev
          : effectiveSttModels[0] ?? null
      );
      setSelectedTtsModel((prev) =>
        prev && effectiveTtsModels.includes(prev)
          ? prev
          : effectiveTtsModels[0] ?? null
      );
    } catch {
      // leave lists empty
      setSttModels([]);
      setTtsModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModelsSafe() {
      if (cancelled) return;
      await loadModels();
    }

    void loadModelsSafe();

    const unsubStt = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Stt) return;
      void loadModelsSafe();
    });
    const unsubTts = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Tts) return;
      void loadModelsSafe();
    });

    return () => {
      cancelled = true;
      unsubStt();
      unsubTts();
    };
  }, [loadModels]);

  // ── resolve model sources ──────────────────────────────────────────────────
  const resolveSttSource = useCallback(
    async (folder: string) => {
      const source = sttPadIds.includes(folder)
        ? sttPadPath
          ? getFileModelPath(folder, ModelCategory.Stt, sttPadPath)
          : getFileModelPath(folder, ModelCategory.Stt)
        : sttDownloadedIds.includes(folder)
        ? getFileModelPath(folder, ModelCategory.Stt)
        : getAssetModelPath(folder);
      return toDetectSource(source);
    },
    [sttPadIds, sttPadPath, sttDownloadedIds]
  );

  const resolveTtsSource = useCallback(
    async (folder: string) => {
      const source = ttsPadIds.includes(folder)
        ? ttsPadPath
          ? getFileModelPath(folder, ModelCategory.Tts, ttsPadPath)
          : getFileModelPath(folder, ModelCategory.Tts)
        : ttsDownloadedIds.includes(folder)
        ? getFileModelPath(folder, ModelCategory.Tts)
        : getAssetModelPath(folder);
      return toDetectSource(source);
    },
    [ttsPadIds, ttsPadPath, ttsDownloadedIds]
  );

  // ── cleanup helpers ────────────────────────────────────────────────────────
  const releaseAllResources = useCallback(async () => {
    // Cleanup order per plan: stop mic → cancel ingest → stop STT → finalize sttText → stop TTS → release buffers → destroy engines
    await stopMicToLiveAudioBuffer().catch(() => {});

    const ingest = ingestRef.current;
    ingestRef.current = null;
    if (ingest) {
      ingest.cancel();
    }

    const sttPipeline = sttPipelineRef.current;
    sttPipelineRef.current = null;
    if (sttPipeline) {
      await sttPipeline.stop().catch(() => {});
    }

    const sttText = sttOutputTextRef.current;
    sttOutputTextRef.current = null;
    if (sttText) {
      await finalizeLiveTextBuffer(sttText.bufferId).catch(() => {});
      await releasePipelineTextBuffer(sttText.bufferId).catch(() => {});
      sttText.unsubscribeEvents();
    }

    const ttsPipeline = ttsPipelineRef.current;
    ttsPipelineRef.current = null;
    if (ttsPipeline) {
      await ttsPipeline.stop().catch(() => {});
    }

    const ttsText = ttsInputTextRef.current;
    ttsInputTextRef.current = null;
    if (ttsText) {
      await releasePipelineTextBuffer(ttsText.bufferId).catch(() => {});
      ttsText.unsubscribeEvents();
    }

    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      await player.destroy().catch(() => {});
    }

    const sttAudio = sttInputAudioRef.current;
    sttInputAudioRef.current = null;
    if (sttAudio) {
      await releasePipelineAudioBuffer(sttAudio.bufferId).catch(() => {});
    }

    const ttsAudio = ttsOutputAudioRef.current;
    ttsOutputAudioRef.current = null;
    if (ttsAudio) {
      await releasePipelineAudioBuffer(ttsAudio.bufferId).catch(() => {});
    }

    const sttEng = sttEngineRef.current;
    sttEngineRef.current = null;
    const ttsEng = ttsEngineRef.current;
    ttsEngineRef.current = null;
    await Promise.all([
      sttEng ? sttEng.destroy().catch(() => {}) : Promise.resolve(),
      ttsEng ? ttsEng.destroy().catch(() => {}) : Promise.resolve(),
    ]);

    setActiveSteps(new Set());
  }, []);

  // ── file picker ────────────────────────────────────────────────────────────
  const pickFile = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      if (result) {
        setPickedFileUri(result.uri);
        setPickedFileName(result.name ?? result.uri);
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

  // ── start pipeline ─────────────────────────────────────────────────────────
  const startPipeline = useCallback(async () => {
    if (!selectedSttModel || !selectedTtsModel) return;
    if (sourceMode === 'file' && !pickedFileUri) return;
    if (pipelineState !== 'idle') return;

    setValidationError(null);
    setPipelineState('starting');
    setError(null);
    setPartialText('');
    setCommittedSegments([]);
    setSegmentEvents([]);
    segCountRef.current = 0;

    await releaseAllResources();

    try {
      // ── Validate streaming STT ──────────────────────────────────────────────
      setStatusText('Detecting STT model…');
      const sttSource = await resolveSttSource(selectedSttModel);
      const detection = await detectSttModel(sttSource, { modelType: 'auto' });
      if (!detection.success) {
        throw new Error(
          `STT model detection failed: ${detection.error ?? 'unknown error'}`
        );
      }
      if (!detection.isStreaming) {
        setValidationError(
          'This STT model is offline-only. Pick a streaming-capable model for the Live Pipeline screen.'
        );
        setPipelineState('idle');
        setStatusText('');
        return;
      }

      // ── Init STT engine ────────────────────────────────────────────────────
      setStatusText('Initializing streaming STT…');
      const sttEngine = await createStreamingSTT({
        modelSource: sttSource,
        modelType: 'auto',
        numThreads: NUM_THREADS,
      });
      sttEngineRef.current = sttEngine;

      // ── Init TTS engine ────────────────────────────────────────────────────
      setStatusText('Initializing streaming TTS…');
      const ttsSource = await resolveTtsSource(selectedTtsModel);
      const ttsEngine = await createStreamingTTS({
        modelSource: ttsSource,
        modelType: 'auto',
        numThreads: NUM_THREADS,
      });
      ttsEngineRef.current = ttsEngine;
      const ttsSampleRate = await ttsEngine.getSampleRate();

      // ── Create audio buffers ───────────────────────────────────────────────
      const sttInputAudio = await createEmptyLiveAudioBuffer({
        sampleRate: STT_INPUT_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      sttInputAudioRef.current = sttInputAudio;

      const ttsOutputAudio = await createEmptyLiveAudioBuffer({
        sampleRate: ttsSampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      ttsOutputAudioRef.current = ttsOutputAudio;

      // ── Create TTS input text buffer ───────────────────────────────────────
      // If mode=auto, attach segmentation engine so forwarded partial text gets
      // re-committed at sentence/length boundaries before reaching TTS.
      const ttsSegOption = buildSegmentationOption(textSegConfig);
      const ttsInputText = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: false, minIntervalMs: 0 } },
        ...(ttsSegOption?.mode === 'auto' && ttsSegOption.policy
          ? {
              segmentation: {
                mode: 'auto' as const,
                policy: ttsSegOption.policy,
              },
            }
          : {}),
      });
      ttsInputTextRef.current = ttsInputText;

      // ── Create STT output text buffer ──────────────────────────────────────
      // onSegment callback forwards committed STT segments to TTS input buffer.
      let localSegCount = 0;
      const sttOutputText = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: true, minIntervalMs: 50 } },
        onPartial: (event) => {
          setPartialText(event.partialText);
        },
        onSegment: (event) => {
          const seg = event.segment;
          const text = seg.domain === 'text' ? seg.text : '';
          if (!text) return;

          localSegCount += 1;
          const idx = localSegCount;

          // Forward to TTS input buffer
          const ttsId = ttsInputTextRef.current?.bufferId;
          if (ttsId) {
            if (ttsSegOption?.mode === 'auto') {
              // Forward as partial so the TTS segmentation engine re-commits at boundaries
              appendPartial(ttsId, text).catch(() => {});
            } else {
              // Forward directly as a committed segment
              appendLiveTextSegment(ttsId, text).catch(() => {});
            }
          }

          setPartialText('');
          setCommittedSegments((prev) => {
            const next = [...prev, text];
            return next.length > 5 ? next.slice(next.length - 5) : next;
          });
          setSegmentEvents((prev) => {
            const ev: SegmentEvent = { index: idx, text };
            const next = [...prev, ev];
            return next.length > MAX_SEGMENT_EVENTS
              ? next.slice(next.length - MAX_SEGMENT_EVENTS)
              : next;
          });
        },
      });
      sttOutputTextRef.current = sttOutputText;

      // ── Start pipelines ────────────────────────────────────────────────────
      const sttPipeline = await sttEngine.transcribe(
        sttInputAudio,
        sttOutputText,
        { chunkSize: 3200 }
      );
      sttPipelineRef.current = sttPipeline;

      const ttsPipeline = await ttsEngine.synthesize(
        ttsInputText.bufferId,
        ttsOutputAudio.bufferId,
        {}
      );
      ttsPipelineRef.current = ttsPipeline;

      // ── Start PCM player ───────────────────────────────────────────────────
      const player = await createPcmPlayer(ttsOutputAudio, {
        onEnded: () => {
          setActiveSteps((prev) => {
            const s = new Set(prev);
            s.delete('play');
            return s;
          });
        },
      });
      playerRef.current = player;

      setActiveSteps(new Set<PipelineStep>(['input', 'stt', 'tts', 'play']));
      setPipelineState('running');

      // ── Start source ───────────────────────────────────────────────────────
      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(sttInputAudio, { emitToJs: false });
        setStatusText(
          'Microphone active. Speech → STT → TTS → Playback is running.'
        );
      } else {
        const source = toFileSource(pickedFileUri!);
        setStatusText('Ingesting file into STT pipeline…');
        const ingest = await ingestFileToLiveAudioBuffer(
          sttInputAudio.bufferId,
          source,
          {
            targetSampleRateHz: STT_INPUT_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
          }
        );
        ingestRef.current = ingest;

        void ingest.done
          .then(() => {
            setStatusText('File ingested. Waiting for STT and TTS to drain…');
          })
          .catch((err) => {
            const code = (err as { code?: string })?.code;
            if (code !== 'DECODE_CANCELLED') {
              setError(normalizeErrorMessage(err));
            }
          });
      }

      // Watch for pipeline completion
      void Promise.all([
        sttPipeline.completed.catch(() => {}),
        ttsPipeline.completed.catch(() => {}),
      ]).then(async () => {
        setStatusText('Pipeline completed.');
        await releaseAllResources();
        setPipelineState('idle');
      });
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStatusText('Failed to start pipeline.');
      await releaseAllResources();
      setPipelineState('idle');
    }
  }, [
    selectedSttModel,
    selectedTtsModel,
    sourceMode,
    pickedFileUri,
    pipelineState,
    textSegConfig,
    releaseAllResources,
    resolveSttSource,
    resolveTtsSource,
  ]);

  const stopPipeline = useCallback(async () => {
    if (pipelineState !== 'running' && pipelineState !== 'starting') return;
    setPipelineState('stopping');
    setStatusText('Stopping pipeline…');
    await releaseAllResources();
    setPipelineState('idle');
    setStatusText('Stopped.');
  }, [pipelineState, releaseAllResources]);

  const canStart =
    !!selectedSttModel &&
    !!selectedTtsModel &&
    (sourceMode === 'mic' || !!pickedFileUri) &&
    pipelineState === 'idle';

  return (
    <SafeAreaView style={styles.container}>
      <ScreenIntroModal screenId="LivePipelineShowcase" />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Pipeline diagram */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pipeline</Text>
          <View style={styles.pipelineDiagram}>
            {(['input', 'stt', 'tts', 'play'] as PipelineStep[]).map(
              (step, i) => {
                const isActive = activeSteps.has(step);
                const labels: Record<PipelineStep, string> = {
                  input: sourceMode === 'mic' ? '🎤 Input' : '📁 File',
                  stt: '📝 STT',
                  tts: '🔊 TTS',
                  play: '▶️ Play',
                };
                return (
                  <>
                    {i > 0 && (
                      <Text
                        key={`arrow-${step}`}
                        style={[
                          styles.pipelineArrow,
                          isActive && styles.pipelineArrowActive,
                        ]}
                      >
                        →
                      </Text>
                    )}
                    <View
                      key={step}
                      style={[
                        styles.pipelineStep,
                        isActive && styles.pipelineStepActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.pipelineStepLabel,
                          isActive && styles.pipelineStepLabelActive,
                        ]}
                      >
                        {labels[step]}
                      </Text>
                    </View>
                  </>
                );
              }
            )}
          </View>
        </View>

        {/* Source selector */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Input Source</Text>
          <View style={styles.sourceToggle}>
            {(['mic', 'file'] as SourceMode[]).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={[
                  styles.sourceToggleBtn,
                  sourceMode === mode && styles.sourceToggleBtnActive,
                ]}
                onPress={() => setSourceMode(mode)}
                disabled={pipelineState !== 'idle'}
              >
                <Text
                  style={[
                    styles.sourceToggleText,
                    sourceMode === mode && styles.sourceToggleTextActive,
                  ]}
                >
                  {mode === 'mic' ? '🎤 Microphone' : '📁 File'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {sourceMode === 'file' && (
            <>
              <TouchableOpacity
                style={[styles.optionButton, { alignSelf: 'flex-start' }]}
                onPress={pickFile}
                disabled={pipelineState !== 'idle'}
              >
                <Text style={styles.optionButtonText}>
                  {pickedFileName ? `📁 ${pickedFileName}` : 'Pick audio file…'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* STT model */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>STT Model (Streaming)</Text>
          <Text style={styles.hint}>
            Only streaming-capable models work here. Offline-only models will be
            rejected at startup.
          </Text>
          {loadingModels ? (
            <ActivityIndicator size="small" />
          ) : sttModels.length === 0 ? (
            <Text style={styles.hint}>
              No STT models found. Download one from the Model Downloads screen.
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.optionRow}>
                {sttModels.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[
                      styles.optionButton,
                      selectedSttModel === m && styles.optionButtonActive,
                    ]}
                    onPress={() => setSelectedSttModel(m)}
                    disabled={pipelineState !== 'idle'}
                  >
                    <Text
                      style={[
                        styles.optionButtonText,
                        selectedSttModel === m && styles.optionButtonTextActive,
                      ]}
                    >
                      {getModelDisplayName(m)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          )}
        </View>

        {/* TTS model + text segmentation */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            TTS Model (Offline model used by Streaming TTS)
          </Text>
          {loadingModels ? (
            <ActivityIndicator size="small" />
          ) : ttsModels.length === 0 ? (
            <Text style={styles.hint}>
              No TTS models found. Download one from the Model Downloads screen.
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.optionRow}>
                {ttsModels.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[
                      styles.optionButton,
                      selectedTtsModel === m && styles.optionButtonActive,
                    ]}
                    onPress={() => setSelectedTtsModel(m)}
                    disabled={pipelineState !== 'idle'}
                  >
                    <Text
                      style={[
                        styles.optionButtonText,
                        selectedTtsModel === m && styles.optionButtonTextActive,
                      ]}
                    >
                      {getModelDisplayName(m)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          )}
          <Text style={styles.sectionTitle}>Text Segmentation (STT→TTS)</Text>
          <Text style={styles.hint}>
            Off: each STT segment is forwarded directly to TTS.{'\n'}
            Auto: partial STT output is re-segmented at sentence boundaries
            before being synthesized.
          </Text>
          <SegmentationPolicyControls
            variant="text-streaming"
            value={textSegConfig}
            onChange={setTextSegConfig}
            disabled={pipelineState !== 'idle'}
          />
        </View>

        {/* Validation error */}
        {validationError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{validationError}</Text>
          </View>
        ) : null}

        {/* Runtime error */}
        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="warning" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Start / Stop */}
        <View style={styles.section}>
          {pipelineState === 'running' || pipelineState === 'stopping' ? (
            <>
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" />
                <Text style={styles.statusText}>{statusText}</Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.runButton,
                  { backgroundColor: '#D32F2F' },
                  pipelineState === 'stopping' && styles.runButtonDisabled,
                ]}
                onPress={stopPipeline}
                disabled={pipelineState === 'stopping'}
              >
                <Ionicons name="stop" size={18} color="#FFF" />
                <Text style={styles.runButtonText}>Stop</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {statusText ? (
                <Text style={styles.statusText}>{statusText}</Text>
              ) : null}
              {pipelineState === 'starting' ? (
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" />
                  <Text style={styles.statusText}>Starting pipeline…</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.runButton,
                    !canStart && styles.runButtonDisabled,
                  ]}
                  onPress={startPipeline}
                  disabled={!canStart}
                >
                  <Ionicons name="play" size={18} color="#FFF" />
                  <Text style={styles.runButtonText}>Start Live Pipeline</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {/* Live transcript */}
        {(pipelineState === 'running' ||
          committedSegments.length > 0 ||
          partialText) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Live Transcript</Text>
            <View style={styles.transcriptBox}>
              {committedSegments.length > 0 ? (
                committedSegments.map((seg, i) => (
                  <Text key={`seg-${i}`} style={styles.committedText}>
                    {seg}
                  </Text>
                ))
              ) : (
                <Text style={styles.hint}>Waiting for speech…</Text>
              )}
              {partialText ? (
                <Text style={styles.partialText}>{partialText}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* Segment event log */}
        {segmentEvents.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Segment Events ({segmentEvents.length})
            </Text>
            {segmentEvents.map((ev, idx) => (
              <View
                key={`ev-${ev.index}-${idx}`}
                style={styles.segmentEventRow}
              >
                <Text style={styles.segmentEventIndex}>#{ev.index}</Text>
                <Text style={styles.segmentEventText} numberOfLines={2}>
                  {ev.text}
                </Text>
                <View style={styles.metaChip}>
                  <Text style={styles.metaChipText}>→ TTS</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
