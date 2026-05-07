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
  createTTS,
  detectTtsModel,
  type TtsEngine,
  type TtsLivePipelineOptions,
  type TtsPipelineHandle,
} from 'react-native-sherpa-onnx/tts';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromLive,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  finalizeLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  toDetectSource,
} from '../../modelConfig';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import {
  EngineModeModelSelector,
  TTS_STREAMING_MODE_HINT,
  TTS_STREAMING_MODEL_AREA_PLACEHOLDER,
  type EngineMode,
} from '../../components/EngineModeModelSelector';
import { PipelineOfflineAudioResultCard } from '../../components/PipelineOfflineAudioResultCard';
import { styles } from './LivePipelineShowcaseScreen.styles';

const STT_INPUT_SAMPLE_RATE = 16000;
const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;
const MAX_SEGMENT_EVENTS = 20;
/** Same interval as STTStreamingScreen `syncTranscript` for comparable UI updates. */
const STT_TRANSCRIPT_POLL_MS = 150;

type PipelineState = 'idle' | 'starting' | 'running' | 'stopping';
type SourceMode = 'mic' | 'file';

type PipelineStep = 'input' | 'stt' | 'tts';

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
  const [streamingSttModelIds, setStreamingSttModelIds] = useState<Set<string>>(
    new Set()
  );
  const [offlineSttModelIds, setOfflineSttModelIds] = useState<Set<string>>(
    new Set()
  );
  const [ttsModels, setTtsModels] = useState<string[]>([]);
  const [streamingTtsModelIds, setStreamingTtsModelIds] = useState<Set<string>>(
    new Set()
  );
  const [sttPadIds, setSttPadIds] = useState<string[]>([]);
  const [ttsPadIds, setTtsPadIds] = useState<string[]>([]);
  const [sttPadPath, setSttPadPath] = useState<string | null>(null);
  const [ttsPadPath, setTtsPadPath] = useState<string | null>(null);
  const [sttDownloadedIds, setSttDownloadedIds] = useState<string[]>([]);
  const [ttsDownloadedIds, setTtsDownloadedIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // ── selection ──────────────────────────────────────────────────────────────
  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [sttEngineMode, setSttEngineMode] = useState<EngineMode>('streaming');
  const [ttsEngineMode, setTtsEngineMode] = useState<EngineMode>('streaming');
  const [selectedSttModel, setSelectedSttModel] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [pickedFileUri, setPickedFileUri] = useState<string | null>(null);
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);
  const [sttSegConfig, setSttSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
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
  const [pipelineTtsOutput, setPipelineTtsOutput] = useState<{
    bufferId: string;
    sourceLabel: string;
    sampleRate: number;
    durationMs: number;
  } | null>(null);

  // ── refs ───────────────────────────────────────────────────────────────────
  const sttEngineRef = useRef<LiveSttEngine | null>(null);
  const ttsEngineRef = useRef<TtsEngine | null>(null);
  const sttInputAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const ttsOutputAudioRef = useRef<LiveAudioBufferRef | null>(null);
  /** Single buffer: STT `transcribe` commits here; TTS live overload `synthesize` consumes the same buffer natively (no JS copy). */
  const sharedSttTtsTextRef = useRef<LiveTextBufferRef | null>(null);
  const sttPipelineRef = useRef<SttPipelineHandle | null>(null);
  const ttsPipelineRef = useRef<TtsPipelineHandle | null>(null);
  const ingestRef = useRef<FileIngestHandle | null>(null);
  const sttTranscriptPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  /** Segment log cursor for showcase UI only (segment event list); TTS uses native drain on the shared buffer. */
  const lastUiPolledSegmentCountRef = useRef(0);
  /** Monotonic index for segment event log rows. */
  const sttSegmentEventIndexRef = useRef(0);
  const capturedTtsOfflineIdRef = useRef<string | null>(null);
  /** Prevents concurrent teardown (e.g. Stop + pipeline.completed both calling release). */
  const releaseAllInFlightRef = useRef<Promise<void> | null>(null);

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

      const sttDetectionRows = await Promise.all(
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
            if (!detected.success) {
              return { folder, streaming: false, offline: false };
            }
            return {
              folder,
              streaming: detected.isStreaming,
              offline: !detected.isStreaming,
            };
          } catch {
            return { folder, streaming: false, offline: false };
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
            return detected.success
              ? { folder, isStreaming: !!detected.isStreaming }
              : null;
          } catch {
            return null;
          }
        })
      );

      const streamingSttModelsSet = new Set(
        sttDetectionRows.filter((r) => r.streaming).map((r) => r.folder)
      );
      const offlineSttModelsSet = new Set(
        sttDetectionRows.filter((r) => r.offline).map((r) => r.folder)
      );
      const validSttModels = sttCandidates.filter(
        (folder) =>
          streamingSttModelsSet.has(folder) || offlineSttModelsSet.has(folder)
      );

      const validTtsModels = validTtsRaw
        .filter((r): r is { folder: string; isStreaming: boolean } => r != null)
        .map((r) => r.folder);
      const streamingTtsModelsSet = new Set(
        validTtsRaw
          .filter((r) => r != null && r.isStreaming)
          .map((r) => r!.folder)
      );

      setSttPadIds(padSttIds);
      setTtsPadIds(padTtsIds);
      setSttPadPath(padSttIds.length > 0 ? padPath : null);
      setTtsPadPath(padTtsIds.length > 0 ? padPath : null);
      setSttDownloadedIds([...new Set([...sttDl, ...sttFsIds, ...padSttIds])]);
      setTtsDownloadedIds([...new Set([...ttsDl, ...ttsFsIds, ...padTtsIds])]);
      setSttModels(validSttModels);
      setStreamingSttModelIds(streamingSttModelsSet);
      setOfflineSttModelIds(offlineSttModelsSet);
      setTtsModels(validTtsModels);
      setStreamingTtsModelIds(streamingTtsModelsSet);

      const initialStt =
        sttEngineMode === 'streaming'
          ? validSttModels.find((m) => streamingSttModelsSet.has(m))
          : validSttModels.find((m) => offlineSttModelsSet.has(m));

      const initialTts =
        ttsEngineMode === 'streaming' ? null : validTtsModels[0];

      setSelectedSttModel((prev) =>
        prev && validSttModels.includes(prev) ? prev : initialStt ?? null
      );
      setSelectedTtsModel((prev) => {
        if (ttsEngineMode === 'streaming') return null;
        return prev && validTtsModels.includes(prev)
          ? prev
          : initialTts ?? null;
      });
    } catch {
      // leave lists empty
      setSttModels([]);
      setTtsModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [sttEngineMode, ttsEngineMode]);

  // Auto-enforce segmentation on mode switch
  useEffect(() => {
    if (sttEngineMode === 'offline') {
      setSttSegConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: { evaluator: 'speech_energy_silence', maxSegmentMs: 10000 },
          };
        }
        return prev;
      });
    }
  }, [sttEngineMode]);

  useEffect(() => {
    if (ttsEngineMode === 'offline') {
      setTextSegConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: {
              evaluator: 'text_synthetic_auto',
              maxLengthChars: 320,
              sentenceBoundary: true,
            },
          };
        }
        return prev;
      });
    }
  }, [ttsEngineMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadModelsSafe() {
      if (cancelled) return;
      await loadModels();
    }

    loadModelsSafe().catch(() => {});

    const unsubStt = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Stt) return;
      loadModelsSafe().catch(() => {});
    });
    const unsubTts = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Tts) return;
      loadModelsSafe().catch(() => {});
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

  const releasePriorCapturedTts = useCallback(async () => {
    const id = capturedTtsOfflineIdRef.current;
    capturedTtsOfflineIdRef.current = null;
    setPipelineTtsOutput(null);
    if (id) {
      await releasePipelineAudioBuffer(id).catch(() => {});
    }
  }, []);

  const captureLiveTtsToOfflineSnapshot = useCallback(
    async (ttsLive: LiveAudioBufferRef) => {
      try {
        try {
          await finalizeLiveAudioBuffer(ttsLive.bufferId);
        } catch {
          /* already finalized */
        }
        const offline = await createOfflineAudioBufferFromLive(
          ttsLive.bufferId,
          'fullIfSpooled'
        );
        if (offline.info.numSamples <= 0) {
          await releasePipelineAudioBuffer(offline.bufferId).catch(() => {});
          return;
        }
        const prior = capturedTtsOfflineIdRef.current;
        if (prior && prior !== offline.bufferId) {
          await releasePipelineAudioBuffer(prior).catch(() => {});
        }
        capturedTtsOfflineIdRef.current = offline.bufferId;
        setPipelineTtsOutput({
          bufferId: offline.bufferId,
          sourceLabel: 'Pipeline TTS output',
          sampleRate: offline.info.sampleRate,
          durationMs: offline.info.durationMs,
        });
      } catch {
        /* ignore snapshot errors */
      }
    },
    []
  );

  const stopSttTranscriptPolling = useCallback(() => {
    if (sttTranscriptPollRef.current) {
      clearInterval(sttTranscriptPollRef.current);
      sttTranscriptPollRef.current = null;
    }
  }, []);

  /**
   * Same reads as STTStreamingScreen `syncTranscript` for UI parity only.
   * STT→TTS data flow uses one native `LiveTextBuffer` (no JS forwarding).
   */
  const syncTranscriptStt = useCallback(async () => {
    const textBuffer = sharedSttTtsTextRef.current;
    if (!textBuffer) return;

    const bufferId = textBuffer.bufferId;
    let segmentCountNow: number;
    try {
      segmentCountNow = await getLiveTextBufferSegmentCount(bufferId);
    } catch {
      return;
    }

    const segments =
      segmentCountNow > 0
        ? await getLiveTextBufferSegments(bufferId, 0, segmentCountNow)
        : [];

    let partial = '';
    try {
      partial = await getLiveTextBufferPartialSlice(bufferId, 0, 4096);
    } catch {
      /* ignore */
    }
    setPartialText(partial.trim());

    const nonEmptyTexts = segments
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    setCommittedSegments(
      nonEmptyTexts.length > 5
        ? nonEmptyTexts.slice(nonEmptyTexts.length - 5)
        : nonEmptyTexts
    );

    const prevUi = lastUiPolledSegmentCountRef.current;
    if (segmentCountNow <= prevUi) {
      return;
    }

    const newSegments = await getLiveTextBufferSegments(
      bufferId,
      prevUi,
      segmentCountNow - prevUi
    );

    for (const seg of newSegments) {
      const text = seg.text.trim();
      if (text) {
        sttSegmentEventIndexRef.current += 1;
        const idx = sttSegmentEventIndexRef.current;
        setSegmentEvents((prevEvs) => {
          const ev: SegmentEvent = { index: idx, text };
          const next = [...prevEvs, ev];
          return next.length > MAX_SEGMENT_EVENTS
            ? next.slice(next.length - MAX_SEGMENT_EVENTS)
            : next;
        });
      }
    }
    lastUiPolledSegmentCountRef.current = segmentCountNow;
  }, []);

  // ── cleanup helpers ────────────────────────────────────────────────────────
  const releaseAllResources = useCallback(async () => {
    const existing = releaseAllInFlightRef.current;
    if (existing) {
      await existing;
      return;
    }

    const releaseToken: { p: Promise<void> | null } = { p: null };
    releaseToken.p = (async () => {
      try {
        await syncTranscriptStt().catch(() => {});
        stopSttTranscriptPolling();
        // Cleanup order: stop mic → ingest → STT pipeline → flush/stop TTS →
        // snapshot TTS live audio → finalize/release shared text + buffers → destroy engines.
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

        const ttsAudioForCapture = ttsOutputAudioRef.current;

        const ttsPipeline = ttsPipelineRef.current;
        ttsPipelineRef.current = null;
        if (ttsPipeline) {
          await ttsPipeline.flush().catch(() => {});
          await ttsPipeline.stop().catch(() => {});
        }

        if (ttsAudioForCapture) {
          await captureLiveTtsToOfflineSnapshot(ttsAudioForCapture);
        }

        const sharedText = sharedSttTtsTextRef.current;
        sharedSttTtsTextRef.current = null;
        if (sharedText) {
          await finalizeLiveTextBuffer(sharedText.bufferId).catch(() => {});
          await releasePipelineTextBuffer(sharedText.bufferId).catch(() => {});
          sharedText.unsubscribeEvents();
        }

        const sttAudio = sttInputAudioRef.current;
        sttInputAudioRef.current = null;
        if (sttAudio) {
          await releasePipelineAudioBuffer(sttAudio.bufferId).catch(() => {});
        }

        ttsOutputAudioRef.current = null;
        if (ttsAudioForCapture) {
          await releasePipelineAudioBuffer(ttsAudioForCapture.bufferId).catch(
            () => {}
          );
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
      } finally {
        const p = releaseToken.p;
        if (p != null && releaseAllInFlightRef.current === p) {
          releaseAllInFlightRef.current = null;
        }
      }
    })();

    releaseAllInFlightRef.current = releaseToken.p;
    await releaseToken.p;
  }, [
    captureLiveTtsToOfflineSnapshot,
    stopSttTranscriptPolling,
    syncTranscriptStt,
  ]);

  useEffect(() => {
    return () => {
      releasePriorCapturedTts().catch(() => {});
    };
  }, [releasePriorCapturedTts]);

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
    lastUiPolledSegmentCountRef.current = 0;
    sttSegmentEventIndexRef.current = 0;

    await releasePriorCapturedTts();
    await releaseAllResources();

    try {
      // ── Resolve and Detect STT ──────────────────────────────────────────────
      setStatusText('Detecting STT model…');
      const sttSource = await resolveSttSource(selectedSttModel);
      const detection = await detectSttModel(sttSource, { modelType: 'auto' });
      if (!detection.success) {
        throw new Error(
          `STT model detection failed: ${detection.error ?? 'unknown error'}`
        );
      }

      // Streaming mode requires streaming-compatible weights; Live Overload requires offline weights.
      if (sttEngineMode === 'streaming' && !detection.isStreaming) {
        setValidationError(
          'This STT model is offline-only. Switch STT to "Live Overload" mode to use it in a live pipeline.'
        );
        setPipelineState('idle');
        setStatusText('');
        return;
      }
      if (sttEngineMode === 'offline' && detection.isStreaming) {
        setValidationError(
          'This STT model is streaming-only. Live Overload needs offline STT weights — pick another STT model or use Streaming STT.'
        );
        setPipelineState('idle');
        setStatusText('');
        return;
      }

      // ── Init STT engine ────────────────────────────────────────────────────
      if (sttEngineMode === 'streaming') {
        setStatusText('Initializing streaming STT…');
        const sttEngine = await createStreamingSTT({
          modelSource: sttSource,
          modelType: 'auto',
          numThreads: NUM_THREADS,
        });
        sttEngineRef.current = sttEngine;
      } else {
        setStatusText('Initializing offline STT (Live Overload)…');
        const { createSTT } = require('react-native-sherpa-onnx/stt');
        const sttEngine = await createSTT({
          modelSource: sttSource,
          modelType: 'auto',
          numThreads: NUM_THREADS,
        });
        sttEngineRef.current = sttEngine;
      }

      // ── Init TTS engine ────────────────────────────────────────────────────
      const ttsSource = await resolveTtsSource(selectedTtsModel);

      setStatusText('Initializing TTS…');
      const ttsEngine = await createTTS({
        modelSource: ttsSource,
        modelType: 'auto',
        numThreads: NUM_THREADS,
      });
      ttsEngineRef.current = ttsEngine;

      const ttsSampleRate = await ttsEngineRef.current!.getSampleRate();

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

      // ── Shared live text buffer (contract: docs/feature-pipelines.md TTS streaming) ──
      // STT commits segments here; `synthesize(LiveText, LiveAudio)` attaches text-domain
      // segmentation and drains commits natively — no second buffer or JS append chain.
      const sharedSttTtsText = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: false, minIntervalMs: 0 } },
      });
      sharedSttTtsTextRef.current = sharedSttTtsText;

      // ── Start pipelines ────────────────────────────────────────────────────
      const sttPipeline = await sttEngineRef.current!.transcribe(
        sttInputAudio,
        sharedSttTtsText,
        {
          chunkSize: 3200,
          ...(() => {
            const opt = buildSegmentationOption(sttSegConfig);
            return opt && opt.mode !== 'off' ? { segmentation: opt } : {};
          })(),
        }
      );
      sttPipelineRef.current = sttPipeline;

      const ttsSegmentation: TtsLivePipelineOptions['segmentation'] = (() => {
        const ttsOpt = buildSegmentationOption(textSegConfig);
        return ttsOpt && ttsOpt.mode === 'auto' && ttsOpt.policy
          ? { mode: 'auto', policy: ttsOpt.policy }
          : {
              mode: 'auto',
              policy: {
                evaluator: 'text_synthetic_auto',
                sentenceBoundary: true,
                maxLengthChars: 500,
              },
            };
      })();

      const ttsPipeline = await ttsEngineRef.current!.synthesize(
        sharedSttTtsText.bufferId,
        ttsOutputAudio.bufferId,
        {
          segmentation: ttsSegmentation,
        }
      );
      ttsPipelineRef.current = ttsPipeline;

      setActiveSteps(new Set<PipelineStep>(['input', 'stt', 'tts']));
      setPipelineState('running');

      // ── Start source ───────────────────────────────────────────────────────
      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(sttInputAudio, { emitToJs: false });
        setStatusText(
          'Microphone active. Speech → STT → TTS (no live playback; use TTS output below after stop).'
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

        ingest.done
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

      stopSttTranscriptPolling();
      sttTranscriptPollRef.current = setInterval(() => {
        syncTranscriptStt().catch(() => {});
      }, STT_TRANSCRIPT_POLL_MS);

      // Watch for pipeline completion
      Promise.all([
        sttPipeline.completed.catch(() => {}),
        ttsPipeline.completed.catch(() => {}),
      ])
        .then(async () => {
          setStatusText('Pipeline completed.');
          await releaseAllResources();
          setPipelineState('idle');
        })
        .catch(() => {});
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
    sttSegConfig,
    sttEngineMode,
    releaseAllResources,
    releasePriorCapturedTts,
    resolveSttSource,
    resolveTtsSource,
    syncTranscriptStt,
    stopSttTranscriptPolling,
  ]);

  const stopPipeline = useCallback(async () => {
    if (pipelineState !== 'running' && pipelineState !== 'starting') return;
    setPipelineState('stopping');
    setStatusText('Stopping pipeline…');
    await releaseAllResources();
    setPipelineState('idle');
    setStatusText('Stopped.');
  }, [pipelineState, releaseAllResources]);

  const ttsReadyForPipeline = ttsEngineMode === 'offline' && !!selectedTtsModel;

  const canStart =
    !!selectedSttModel &&
    ttsReadyForPipeline &&
    (sourceMode === 'mic' || !!pickedFileUri) &&
    pipelineState === 'idle';

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
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
            {(['input', 'stt', 'tts'] as PipelineStep[]).map((step, i) => {
              const isActive = activeSteps.has(step);
              const labels: Record<PipelineStep, string> = {
                input: sourceMode === 'mic' ? '🎤 Input' : '📁 File',
                stt: '📝 STT',
                tts: '🔊 TTS',
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
            })}
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
                style={[styles.optionButton, styles.optionButtonAlignStart]}
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

        <EngineModeModelSelector
          label={`STT Model (${
            sttEngineMode === 'streaming' ? 'Streaming' : 'Offline'
          })`}
          engineMode={sttEngineMode}
          onEngineModeChange={setSttEngineMode}
          models={sttModels}
          selectedModel={selectedSttModel}
          onModelSelect={setSelectedSttModel}
          isModelStreamingCapable={(m) => streamingSttModelIds.has(m)}
          isModelOfflineCapable={(m) => offlineSttModelIds.has(m)}
          loading={loadingModels}
          disabled={pipelineState !== 'idle'}
        />

        {/* STT segmentation (only shown in Live Overload mode) */}
        {sttEngineMode === 'offline' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Speech Segmentation</Text>
            <SegmentationPolicyControls
              variant="speech-offline"
              value={sttSegConfig}
              onChange={setSttSegConfig}
              disabled={pipelineState !== 'idle'}
              disableOff
              offDisabledMessage="Live Overload requires mandatory segmentation. Choose Auto or Manual."
            />
          </View>
        )}

        {/* TTS model + text segmentation */}
        <EngineModeModelSelector
          label={`TTS Model (${
            ttsEngineMode === 'streaming' ? 'Streaming' : 'Offline'
          })`}
          engineMode={ttsEngineMode}
          onEngineModeChange={setTtsEngineMode}
          models={ttsModels}
          selectedModel={selectedTtsModel}
          onModelSelect={setSelectedTtsModel}
          isModelStreamingCapable={(m) => streamingTtsModelIds.has(m)}
          loading={loadingModels}
          disabled={pipelineState !== 'idle'}
          streamingHintOverride={TTS_STREAMING_MODE_HINT}
          streamingModelAreaPlaceholder={TTS_STREAMING_MODEL_AREA_PLACEHOLDER}
        />

        {/* TTS text segmentation */}
        {ttsEngineMode === 'offline' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Text Segmentation (STT→TTS)</Text>
            <Text style={styles.hint}>
              STT and TTS share one LiveTextBuffer — commits stay native. This
              policy configures TTS live overload text segmentation on that
              buffer (chunking before synthesize).{'\n'}
              Auto: sentence/length boundaries; Off: one synthesize chunk per
              STT commit when policy allows.
            </Text>
            <SegmentationPolicyControls
              variant="text-offline"
              value={textSegConfig}
              onChange={setTextSegConfig}
              disabled={pipelineState !== 'idle'}
              disableOff
              offDisabledMessage="Live Overload requires mandatory text segmentation. Choose Auto or Manual."
            />
          </View>
        )}

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
                  styles.runButtonStop,
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
            <Text style={styles.transcriptMetric}>
              Segments: {committedSegments.length}
            </Text>
            <Text style={styles.transcriptLabel}>Committed</Text>
            <Text style={styles.transcriptTextArea} selectable>
              {committedSegments.length > 0
                ? committedSegments.join(' ')
                : 'Waiting for committed segments…'}
            </Text>
            <Text style={styles.transcriptLabelSpaced}>Partial</Text>
            <Text style={styles.transcriptTextAreaPartial} selectable>
              {partialText.trim() || 'Waiting for partial text…'}
            </Text>
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

        {pipelineTtsOutput ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>TTS output (last run)</Text>
            <Text style={styles.hint}>
              After Stop or when the pipeline finishes, synthesized speech is
              captured here. Play, save to a file, or dismiss to free memory.
            </Text>
            <PipelineOfflineAudioResultCard
              bufferId={pipelineTtsOutput.bufferId}
              sourceLabel={pipelineTtsOutput.sourceLabel}
              sampleRate={pipelineTtsOutput.sampleRate}
              durationMs={pipelineTtsOutput.durationMs}
              onDismiss={releasePriorCapturedTts}
              disabled={
                pipelineState === 'running' || pipelineState === 'starting'
              }
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
