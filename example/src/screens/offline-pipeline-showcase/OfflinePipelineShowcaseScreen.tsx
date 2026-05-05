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
  createSTT,
  detectSttModel,
  type SttEngine,
} from 'react-native-sherpa-onnx/stt';
import {
  createTTS,
  detectTtsModel,
  type TtsEngine,
} from 'react-native-sherpa-onnx/tts';
import {
  createEmptyOfflineAudioBuffer,
  releasePipelineAudioBuffer,
  getPipelineAudioBufferInfo,
} from 'react-native-sherpa-onnx/audiobuffer';
import type { OfflineAudioBufferRef } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { getSegments } from 'react-native-sherpa-onnx/segment';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES } from '../../audioConfig';
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
import { styles } from './OfflinePipelineShowcaseScreen.styles';

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;

type RunState = 'idle' | 'running' | 'done' | 'failed';

type SegmentEvent = {
  index: number;
  phase: 'stt' | 'tts';
  label: string;
  durationMs: number;
  reason?: string;
  text?: string;
  speechStartMs?: number;
  speechEndMs?: number;
};

export default function OfflinePipelineShowcaseScreen() {
  // ── model lists ─────────────────────────────────────────────────────────────
  const [sttModels, setSttModels] = useState<string[]>([]);
  const [ttsModels, setTtsModels] = useState<string[]>([]);
  const [sttPadIds, setSttPadIds] = useState<string[]>([]);
  const [ttsPadIds, setTtsPadIds] = useState<string[]>([]);
  const [sttPadPath, setSttPadPath] = useState<string | null>(null);
  const [ttsPadPath, setTtsPadPath] = useState<string | null>(null);
  const [sttDownloadedIds, setSttDownloadedIds] = useState<string[]>([]);
  const [ttsDownloadedIds, setTtsDownloadedIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // ── selection ────────────────────────────────────────────────────────────────
  const [selectedSttModel, setSelectedSttModel] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [sttSegConfig, setSttSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [ttsSegConfig, setTtsSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });

  // ── run state ────────────────────────────────────────────────────────────────
  const [runState, setRunState] = useState<RunState>('idle');
  const [statusText, setStatusText] = useState('');
  const [sttProgress, setSttProgress] = useState(0);
  const [ttsProgress, setTtsProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [segmentEvents, setSegmentEvents] = useState<SegmentEvent[]>([]);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // ── audio buffer widget ──────────────────────────────────────────────────────
  const [audioInfo, setAudioInfo] = useState<OfflineAudioBufferInfo | null>(
    null
  );
  const audioWidgetRef = useRef<OfflineAudioBufferWidgetHandle>(null);

  // ── engine / buffer refs ──────────────────────────────────────────────────────
  const sttEngineRef = useRef<SttEngine | null>(null);
  const ttsEngineRef = useRef<TtsEngine | null>(null);
  const outputAudioRef = useRef<OfflineAudioBufferRef | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── load model lists ──────────────────────────────────────────────────────────
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
      const sttFileBackedSet = new Set([...sttDl, ...sttFsIds, ...padSttIds]);
      const ttsFileBackedSet = new Set([...ttsDl, ...ttsFsIds, ...padTtsIds]);

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

      const offlineSttRaw = await Promise.all(
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
            return detected.success && !detected.isStreaming ? folder : null;
          } catch {
            return null;
          }
        })
      );

      const offlineTtsRaw = await Promise.all(
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

      const offlineSttModels = offlineSttRaw.filter(
        (m): m is string => m != null
      );
      const offlineTtsModels = offlineTtsRaw.filter(
        (m): m is string => m != null
      );
      const effectiveSttModels =
        offlineSttModels.length > 0 ? offlineSttModels : sttCandidates;
      const effectiveTtsModels =
        offlineTtsModels.length > 0 ? offlineTtsModels : ttsCandidates;

      setSttPadIds(padSttIds);
      setTtsPadIds(padTtsIds);
      setSttPadPath(padSttIds.length > 0 ? padPath : null);
      setTtsPadPath(padTtsIds.length > 0 ? padPath : null);
      setSttDownloadedIds([...sttFileBackedSet]);
      setTtsDownloadedIds([...ttsFileBackedSet]);
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

  // ── helper: resolve model FileSource ─────────────────────────────────────────
  const resolveSttSource = useCallback(
    async (folder: string) => {
      const source = sttPadIds.includes(folder)
        ? sttPadPath
          ? getFileModelPath(folder, ModelCategory.Stt, sttPadPath)
          : getFileModelPath(folder, ModelCategory.Stt)
        : sttDownloadedIds.includes(folder)
        ? getFileModelPath(folder, ModelCategory.Stt)
        : getFileModelPath(folder, ModelCategory.Stt);
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
        : getFileModelPath(folder, ModelCategory.Tts);
      return toDetectSource(source);
    },
    [ttsPadIds, ttsPadPath, ttsDownloadedIds]
  );

  // ── cleanup resources ────────────────────────────────────────────────────────
  const releaseOutputAudio = useCallback(async () => {
    const buf = outputAudioRef.current;
    outputAudioRef.current = null;
    if (buf) {
      await releasePipelineAudioBuffer(buf.bufferId).catch(() => {});
    }
  }, []);

  const releasePlayer = useCallback(async () => {
    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      await p.destroy().catch(() => {});
    }
    setIsPlaying(false);
  }, []);

  const destroyEngines = useCallback(async () => {
    const stt = sttEngineRef.current;
    sttEngineRef.current = null;
    const tts = ttsEngineRef.current;
    ttsEngineRef.current = null;
    await Promise.all([
      stt ? stt.destroy().catch(() => {}) : Promise.resolve(),
      tts ? tts.destroy().catch(() => {}) : Promise.resolve(),
    ]);
  }, []);

  // ── run pipeline ─────────────────────────────────────────────────────────────
  const runPipeline = useCallback(async () => {
    if (!audioInfo || !selectedSttModel || !selectedTtsModel) return;
    if (runState === 'running') return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setRunState('running');
    setError(null);
    setTranscript(null);
    setSummaryText(null);
    setSegmentEvents([]);
    setSttProgress(0);
    setTtsProgress(0);

    await releasePlayer();
    await releaseOutputAudio();
    await destroyEngines();

    let textBufferRef: Awaited<
      ReturnType<typeof createEmptyOfflineTextBuffer>
    > | null = null;
    let outputBuf: OfflineAudioBufferRef | null = null;

    try {
      // ─── init engines ───────────────────────────────────────────────────────
      setStatusText('Initializing STT…');
      const sttSource = await resolveSttSource(selectedSttModel);
      const sttEngine = await createSTT({
        modelSource: sttSource,
        modelType: 'auto',
        numThreads: NUM_THREADS,
      });
      sttEngineRef.current = sttEngine;

      setStatusText('Initializing TTS…');
      const ttsSource = await resolveTtsSource(selectedTtsModel);
      const ttsEngine = await createTTS({
        modelSource: ttsSource,
        modelType: 'auto',
        numThreads: NUM_THREADS,
      });
      ttsEngineRef.current = ttsEngine;
      const ttsSampleRate = await ttsEngine.getSampleRate();

      if (abort.signal.aborted) return;

      // ─── STT phase ──────────────────────────────────────────────────────────
      setStatusText('Running STT…');
      textBufferRef = await createEmptyOfflineTextBuffer();

      const sttSeg = buildSegmentationOption(sttSegConfig);
      const sttEvents: SegmentEvent[] = [];

      await sttEngine.transcribe(audioInfo.bufferId, textBufferRef.bufferId, {
        ...(sttSeg ? { segmentation: sttSeg } : {}),
        abortSignal: abort.signal,
        onProgress: (p) => {
          const frac = p.fraction ?? 0;
          setSttProgress(Math.round(frac * 100));
          setStatusText(
            `STT segment ${p.currentSegment + 1}/${
              p.totalSegments
            } (${Math.round(frac * 100)}%)`
          );
          const ev: SegmentEvent = {
            index: p.currentSegment,
            phase: 'stt',
            label: `STT Audio-Chunk ${p.currentSegment + 1}/${p.totalSegments}`,
            durationMs: p.currentSegmentDurationMs ?? 0,
          };
          sttEvents.push(ev);
          setSegmentEvents([...sttEvents]);
        },
      });
      setSttProgress(100);

      if (abort.signal.aborted) return;

      // Read committed speech/text segments (when available) to show detailed
      // segment contents: speech window, text payload, and commit reason.
      const sttDetailedEvents: SegmentEvent[] = [];
      try {
        const [speechSegmentsRaw, textSegmentsRaw] = await Promise.all([
          getSegments(audioInfo.bufferId).catch(() => []),
          getSegments(textBufferRef.bufferId).catch(() => []),
        ]);
        const detailedCount = Math.max(
          speechSegmentsRaw.length,
          textSegmentsRaw.length
        );

        for (let i = 0; i < detailedCount; i += 1) {
          const speechSeg = speechSegmentsRaw[i];
          const textSegRaw = textSegmentsRaw[i];
          const speech = speechSeg?.domain === 'speech' ? speechSeg : null;
          const textSeg = textSegRaw?.domain === 'text' ? textSegRaw : null;
          const speechStartMs =
            speech != null && speech.sampleRate > 0
              ? Math.round((speech.startOffset / speech.sampleRate) * 1000)
              : undefined;
          const speechEndMs =
            speech != null && speech.sampleRate > 0
              ? Math.round((speech.endOffset / speech.sampleRate) * 1000)
              : undefined;

          sttDetailedEvents.push({
            index: i,
            phase: 'stt',
            label: `STT Audio-Chunk ${i + 1}/${detailedCount}`,
            durationMs: speech?.durationMs ?? 0,
            reason: textSeg?.reason ?? speech?.reason,
            text: textSeg?.text,
            speechStartMs,
            speechEndMs,
          });
        }
      } catch {
        // Keep progress-based events only when segment introspection fails.
      }
      if (sttDetailedEvents.length > 0) {
        setSegmentEvents(sttDetailedEvents);
      }

      const textInfo = await getPipelineTextBufferInfo(textBufferRef.bufferId);
      const fullText =
        textInfo.kind === 'offlineTextBuffer' && textInfo.utf16Length > 0
          ? await getOfflineTextBufferTextSlice(
              textBufferRef.bufferId,
              0,
              textInfo.utf16Length
            )
          : '';
      setTranscript(fullText || '(no transcript)');

      // ─── TTS phase ──────────────────────────────────────────────────────────
      setStatusText('Running TTS…');
      outputBuf = await createEmptyOfflineAudioBuffer(ttsSampleRate, 1);
      outputAudioRef.current = outputBuf;

      const ttsSeg = buildSegmentationOption(ttsSegConfig);
      const ttsEventsBase =
        sttDetailedEvents.length > 0
          ? sttDetailedEvents.length
          : sttEvents.length;

      await ttsEngine.synthesize(textBufferRef.bufferId, outputBuf.bufferId, {
        ...(ttsSeg ? { segmentation: ttsSeg } : {}),
        abortSignal: abort.signal,
        onProgress: (p) => {
          const frac = p.fraction ?? 0;
          setTtsProgress(Math.round(frac * 100));
          setStatusText(
            `TTS segment ${p.currentSegment + 1}/${
              p.totalSegments
            } (${Math.round(frac * 100)}%)`
          );
          const ev: SegmentEvent = {
            index: ttsEventsBase + p.currentSegment,
            phase: 'tts',
            label: `TTS Audio-Chunk ${p.currentSegment + 1}/${p.totalSegments}`,
            durationMs: p.currentSegmentDurationMs ?? 0,
          };
          setSegmentEvents((prev) => {
            const next = [...prev];
            next.push(ev);
            return next;
          });
        },
      });
      setTtsProgress(100);

      if (abort.signal.aborted) return;

      // Replace progress-only TTS items with detailed segment contents when
      // segment buffers are available (audio window, text payload, reason).
      const ttsDetailedEvents: SegmentEvent[] = [];
      try {
        const [ttsSpeechSegmentsRaw, ttsTextSegmentsRaw] = await Promise.all([
          getSegments(outputBuf.bufferId).catch(() => []),
          getSegments(textBufferRef.bufferId).catch(() => []),
        ]);
        const detailedCount = Math.max(
          ttsSpeechSegmentsRaw.length,
          ttsTextSegmentsRaw.length
        );

        for (let i = 0; i < detailedCount; i += 1) {
          const speechSeg = ttsSpeechSegmentsRaw[i];
          const textSegRaw = ttsTextSegmentsRaw[i];
          const speech = speechSeg?.domain === 'speech' ? speechSeg : null;
          const textSeg = textSegRaw?.domain === 'text' ? textSegRaw : null;
          const speechStartMs =
            speech != null && speech.sampleRate > 0
              ? Math.round((speech.startOffset / speech.sampleRate) * 1000)
              : undefined;
          const speechEndMs =
            speech != null && speech.sampleRate > 0
              ? Math.round((speech.endOffset / speech.sampleRate) * 1000)
              : undefined;

          ttsDetailedEvents.push({
            index: ttsEventsBase + i,
            phase: 'tts',
            label: `TTS Audio-Chunk ${i + 1}/${detailedCount}`,
            durationMs: speech?.durationMs ?? 0,
            reason: textSeg?.reason ?? speech?.reason,
            text: textSeg?.text,
            speechStartMs,
            speechEndMs,
          });
        }
      } catch {
        // Keep progress-based TTS events only when segment introspection fails.
      }
      if (ttsDetailedEvents.length > 0) {
        setSegmentEvents((prev) => {
          const sttPart = prev.slice(0, ttsEventsBase);
          return [...sttPart, ...ttsDetailedEvents];
        });
      }

      // ─── summary ────────────────────────────────────────────────────────────
      const outInfo = await getPipelineAudioBufferInfo(outputBuf.bufferId);
      const numSamples =
        outInfo.kind === 'offlinePcmBuffer' ? outInfo.numSamples : 0;
      const durationSec = numSamples > 0 ? numSamples / ttsSampleRate : 0;
      setSummaryText(
        `STT → TTS complete · ${durationSec.toFixed(1)}s synthesized audio`
      );
      setStatusText('Done. Tap Play to listen to synthesized audio.');
      setRunState('done');
    } catch (err) {
      if (abort.signal.aborted) {
        setStatusText('Cancelled.');
        setRunState('idle');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatusText('Pipeline failed.');
        setRunState('failed');
      }
    } finally {
      if (textBufferRef) {
        await releasePipelineTextBuffer(textBufferRef.bufferId).catch(() => {});
        textBufferRef = null;
      }
    }
  }, [
    audioInfo,
    selectedSttModel,
    selectedTtsModel,
    runState,
    sttSegConfig,
    ttsSegConfig,
    resolveSttSource,
    resolveTtsSource,
    releasePlayer,
    releaseOutputAudio,
    destroyEngines,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunState('idle');
    setStatusText('Cancelling…');
  }, []);

  const handleReset = useCallback(async () => {
    abortRef.current?.abort();
    await releasePlayer();
    await releaseOutputAudio();
    await destroyEngines();
    setRunState('idle');
    setError(null);
    setTranscript(null);
    setSummaryText(null);
    setSegmentEvents([]);
    setSttProgress(0);
    setTtsProgress(0);
    setStatusText('');
    audioWidgetRef.current?.clear();
  }, [releasePlayer, releaseOutputAudio, destroyEngines]);

  // ── playback ─────────────────────────────────────────────────────────────────
  const handlePlayToggle = useCallback(async () => {
    if (isPlaying) {
      await playerRef.current?.destroy().catch(() => {});
      playerRef.current = null;
      setIsPlaying(false);
      return;
    }
    const buf = outputAudioRef.current;
    if (!buf) return;

    try {
      const p = await createPcmPlayer(buf, {
        onEnded: () => setIsPlaying(false),
      });
      playerRef.current = p;
      setIsPlaying(true);
    } catch (playErr) {
      setError(playErr instanceof Error ? playErr.message : String(playErr));
    }
  }, [isPlaying]);

  const canRun =
    !!audioInfo &&
    !!selectedSttModel &&
    !!selectedTtsModel &&
    runState !== 'running';

  return (
    <SafeAreaView style={styles.container}>
      <ScreenIntroModal screenId="OfflinePipelineShowcase" />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Audio Input */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Audio Input</Text>
          <Text style={styles.hint}>
            Select an audio file to process through the STT → TTS pipeline.
          </Text>
          <OfflineAudioBufferWidget
            ref={audioWidgetRef}
            audioFiles={AUDIO_FILES}
            onBufferReady={(info) => setAudioInfo(info)}
            onBufferReleased={() => setAudioInfo(null)}
            disabled={runState === 'running'}
          />
        </View>

        {/* STT Model */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>STT Model</Text>
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
                    disabled={runState === 'running'}
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
          <Text style={styles.sectionTitle}>STT Segmentation</Text>
          <SegmentationPolicyControls
            variant="speech-offline"
            value={sttSegConfig}
            onChange={setSttSegConfig}
            disabled={runState === 'running'}
          />
        </View>

        {/* TTS Model */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TTS Model</Text>
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
                    disabled={runState === 'running'}
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
          <Text style={styles.sectionTitle}>TTS Segmentation</Text>
          <SegmentationPolicyControls
            variant="text-offline"
            value={ttsSegConfig}
            onChange={setTtsSegConfig}
            disabled={runState === 'running'}
          />
        </View>

        {/* Error */}
        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="warning" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Run / Cancel */}
        <View style={styles.section}>
          {runState === 'running' ? (
            <>
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" />
                <Text style={styles.statusText}>{statusText}</Text>
              </View>
              {sttProgress > 0 && (
                <>
                  <Text style={styles.hint}>STT: {sttProgress}%</Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${sttProgress}%` },
                      ]}
                    />
                  </View>
                </>
              )}
              {ttsProgress > 0 && (
                <>
                  <Text style={styles.hint}>TTS: {ttsProgress}%</Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${ttsProgress}%` },
                      ]}
                    />
                  </View>
                </>
              )}
              <TouchableOpacity
                style={[styles.runButton, { backgroundColor: '#D32F2F' }]}
                onPress={handleCancel}
              >
                <Ionicons name="stop" size={18} color="#FFF" />
                <Text style={styles.runButtonText}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {statusText ? (
                <Text style={styles.statusText}>{statusText}</Text>
              ) : null}
              <TouchableOpacity
                style={[styles.runButton, !canRun && styles.runButtonDisabled]}
                onPress={runPipeline}
                disabled={!canRun}
              >
                <Ionicons name="play" size={18} color="#FFF" />
                <Text style={styles.runButtonText}>Run Pipeline</Text>
              </TouchableOpacity>
              {(runState === 'done' || runState === 'failed') && (
                <TouchableOpacity
                  style={[
                    styles.runButton,
                    { backgroundColor: '#6E6E73', marginTop: 8 },
                  ]}
                  onPress={handleReset}
                >
                  <Ionicons name="refresh" size={18} color="#FFF" />
                  <Text style={styles.runButtonText}>Reset</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {/* Transcript */}
        {transcript ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Transcript</Text>
            <View style={styles.resultCard}>
              <Text style={styles.resultLabel}>STT Output</Text>
              <Text style={styles.resultText}>{transcript}</Text>
            </View>
          </View>
        ) : null}

        {/* Synthesized Audio */}
        {runState === 'done' && outputAudioRef.current ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Synthesized Audio</Text>
            {summaryText ? (
              <View style={styles.metaRow}>
                <View style={styles.metaChip}>
                  <Text style={styles.metaChipText}>{summaryText}</Text>
                </View>
              </View>
            ) : null}
            <View style={styles.playRow}>
              <TouchableOpacity
                style={[
                  styles.playButton,
                  !outputAudioRef.current && styles.playButtonDisabled,
                ]}
                onPress={handlePlayToggle}
                disabled={!outputAudioRef.current}
              >
                <Ionicons
                  name={isPlaying ? 'pause' : 'play'}
                  size={18}
                  color={outputAudioRef.current ? '#007AFF' : '#C7C7CC'}
                />
                <Text
                  style={[
                    styles.playButtonText,
                    !outputAudioRef.current && styles.playButtonTextDisabled,
                  ]}
                >
                  {isPlaying ? 'Pause' : 'Play'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* Segment Events */}
        {segmentEvents.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Pipeline Segments ({segmentEvents.length})
            </Text>
            <Text style={styles.hint}>
              🎤 STT segments input speech into audio chunks. 🔊 TTS segments
              input text into text chunks. Each chunk is processed individually.
            </Text>
            {segmentEvents.slice(-20).map((ev, idx) => (
              <View key={`${ev.phase}-${ev.index}-${idx}`}>
                <View style={styles.segmentEventRow}>
                  <Text style={styles.segmentEventIndex}>
                    {ev.phase === 'stt' ? '🎤' : '🔊'}
                  </Text>
                  <Text style={styles.segmentEventText}>{ev.label}</Text>
                  <Text style={styles.segmentEventMeta}>
                    {ev.durationMs > 0
                      ? `${(ev.durationMs / 1000).toFixed(2)}s`
                      : ''}
                  </Text>
                </View>
                {ev.speechStartMs != null &&
                ev.speechStartMs != null &&
                ev.speechEndMs != null ? (
                  <Text style={styles.segmentEventMeta}>
                    {ev.phase === 'stt'
                      ? 'STT audio window'
                      : 'TTS audio window'}
                    : {(ev.speechStartMs / 1000).toFixed(2)}s -{' '}
                    {(ev.speechEndMs / 1000).toFixed(2)}s
                  </Text>
                ) : null}
                {ev.text ? (
                  <Text style={styles.segmentEventMeta} numberOfLines={2}>
                    {ev.phase === 'stt' ? 'Recognized text' : 'TTS input text'}:{' '}
                    {ev.text}
                  </Text>
                ) : null}
                {ev.reason ? (
                  <Text style={styles.segmentEventMeta}>
                    Commit reason: {ev.reason}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
