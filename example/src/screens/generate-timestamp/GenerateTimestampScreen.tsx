import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  type AlignmentGranularity,
  type AlignmentWarning,
} from 'react-native-sherpa-onnx/alignment';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type SegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { segmentOfflineBuffer } from 'react-native-sherpa-onnx/segment';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { GenerateTimestampModelInitPanel } from '../../components/GenerateTimestampModelInitPanel';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import { useGenerateTimestampModelInit } from '../../hooks/useGenerateTimestampModelInit';
import { AUDIO_FILES } from '../../audioConfig';
import type { RootStackParamList } from '../../types/navigation';
import { styles } from './GenerateTimestampScreen.styles';

type UiMode =
  | 'proportional'
  | 'estimated'
  | 'accurate'
  | 'vad'
  | 'asr_mediated'
  | 'chunked_forced_ctc';

type AlignmentSegmentView = Extract<SegmentMeta, { kind: 'alignment' }>;

type DerivedSubtitleItem = {
  text: string;
  startSec: number;
  endSec: number;
};

type RunResult = {
  mode: UiMode;
  textInBufferId: string;
  audioInBufferId: string;
  outputSegmentBufferId: string;
  anchorSegmentBufferId?: string;
  hypothesisTextBufferId?: string;
  segmentsWritten: number;
  writeDurationMs: number;
  warningCode?: string;
  warnings?: AlignmentWarning[];
  alignmentSegments: AlignmentSegmentView[];
};

type ModeConfig = {
  value: UiMode;
  title: string;
  description: string;
  apiMode: 'proportional' | 'estimated' | 'accurate' | 'vad';
  allowedGranularities: AlignmentGranularity[];
  granularityHint: string;
  requiresAlignmentModel: boolean;
  requiresVadModel: boolean;
  requiresSttModel: boolean;
  requiresEstimatedChunks: boolean;
  runButtonLabel: string;
};

const DEFAULT_REFERENCE_TEXT =
  'This is the reference transcript that should be aligned to the selected audio.';
const DEFAULT_ESTIMATED_SAMPLE_RATE = '16000';
const DEFAULT_ESTIMATED_COUNTS = '3200, 4000, 2800';

const MODE_CONFIGS: ModeConfig[] = [
  {
    value: 'proportional',
    title: 'proportional',
    description:
      'Splits the reference text by granularity and distributes timing by text weight over the full audio duration. No models and no anchors.',
    apiMode: 'proportional',
    allowedGranularities: ['sentence', 'word'],
    granularityHint: 'Only sentence and word are valid for proportional mode.',
    requiresAlignmentModel: false,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run proportional alignment',
  },
  {
    value: 'estimated',
    title: 'estimated',
    description:
      'Uses caller-provided chunk sample counts plus sampleRate to assign estimated timestamps. No acoustic alignment model is involved.',
    apiMode: 'estimated',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Estimated mode only supports sentence and word granularity, plus explicit chunk sample counts.',
    requiresAlignmentModel: false,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: true,
    runButtonLabel: 'Run estimated alignment',
  },
  {
    value: 'accurate',
    title: 'accurate',
    description:
      'Runs plain wav2vec2 CTC forced alignment over the full offline waveform and reference transcript.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word', 'character'],
    granularityHint:
      'Character granularity is only valid in plain accurate mode without segmentation auto.',
    requiresAlignmentModel: true,
    requiresVadModel: false,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment',
  },
  {
    value: 'vad',
    title: 'vad',
    description:
      'Creates offline speech anchors with speech_vad_model and maps text units monotonically onto those anchors. No wav2vec2 model is used.',
    apiMode: 'vad',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'VAD mode only supports sentence and word. Character is rejected by the native API.',
    requiresAlignmentModel: false,
    requiresVadModel: true,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run VAD alignment',
  },
  {
    value: 'asr_mediated',
    title: 'accurate + asr_mediated',
    description:
      'Anchor-constrained accurate alignment with speech anchors plus a timestamped ASR hypothesis buffer H. Missing token timestamps fail with ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS and do not fall back.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Anchor-based accurate modes support sentence and word only. Character is disabled.',
    requiresAlignmentModel: true,
    requiresVadModel: true,
    requiresSttModel: true,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment (asr_mediated)',
  },
  {
    value: 'chunked_forced_ctc',
    title: 'accurate + chunked_forced_ctc',
    description:
      'Anchor-constrained accurate alignment with deterministic chunked forced CTC cursor progression. Uses speech anchors, but no ASR hypothesis buffer.',
    apiMode: 'accurate',
    allowedGranularities: ['sentence', 'word'],
    granularityHint:
      'Anchor-based accurate modes support sentence and word only. Character is disabled.',
    requiresAlignmentModel: true,
    requiresVadModel: true,
    requiresSttModel: false,
    requiresEstimatedChunks: false,
    runButtonLabel: 'Run accurate alignment (chunked_forced_ctc)',
  },
];

const ALL_GRANULARITIES: AlignmentGranularity[] = [
  'sentence',
  'word',
  'character',
];

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0';
  }
  return `${Math.round(ms)}`;
}

function extractErrorCode(message: string): string | null {
  const trimmed = message.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const maybeCode = trimmed.slice(0, idx).trim();
  return maybeCode.length > 0 ? maybeCode : null;
}

function parseEstimatedTimeline(
  sampleRateText: string,
  countsText: string
): { sampleRate: number; segmentSampleCounts: number[] } {
  const sampleRate = parseInt(sampleRateText.trim(), 10);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Estimated mode requires a positive sample rate.');
  }

  const segmentSampleCounts = countsText
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInt(value, 10));

  if (segmentSampleCounts.length === 0) {
    throw new Error(
      'Estimated mode requires at least one segmentSampleCounts value.'
    );
  }
  if (
    segmentSampleCounts.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error('Estimated segmentSampleCounts must be positive integers.');
  }

  return { sampleRate, segmentSampleCounts };
}

function getGranularityDisabledReason(
  mode: UiMode,
  granularity: AlignmentGranularity
): string | null {
  const config = MODE_CONFIGS.find((item) => item.value === mode)!;
  if (config.allowedGranularities.includes(granularity)) {
    return null;
  }
  if (granularity === 'character') {
    if (mode === 'vad') {
      return 'Character is rejected for vad mode.';
    }
    if (mode === 'estimated' || mode === 'proportional') {
      return 'Character is only supported by plain accurate mode.';
    }
    return 'Character is disabled when segmentation auto is active.';
  }
  return config.granularityHint;
}

function SectionCard(props: {
  stepLabel: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>{props.stepLabel}</Text>
        </View>
        <Text style={styles.sectionTitle}>{props.title}</Text>
        {props.description ? (
          <Text style={styles.sectionDescription}>{props.description}</Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

export default function GenerateTimestampScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );

  const modelInit = useGenerateTimestampModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });
  const { alignment, vad, stt, collectRunBlockingIssues } = modelInit;

  const [mode, setMode] = useState<UiMode>('proportional');
  const [granularity, setGranularity] =
    useState<AlignmentGranularity>('sentence');
  const [preparedAudioBuffer, setPreparedAudioBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const audioWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const [referenceTranscript, setReferenceTranscript] = useState(
    DEFAULT_REFERENCE_TEXT
  );
  const [estimatedSampleRateText, setEstimatedSampleRateText] = useState(
    DEFAULT_ESTIMATED_SAMPLE_RATE
  );
  const [estimatedSegmentCountsText, setEstimatedSegmentCountsText] = useState(
    DEFAULT_ESTIMATED_COUNTS
  );

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [segmentsExpanded, setSegmentsExpanded] = useState(true);
  const [subtitlesExpanded, setSubtitlesExpanded] = useState(true);

  onBeforeInitRef.current = () => {
    setResult(null);
    setError(null);
    setErrorCode(null);
  };

  const activeMode = useMemo<ModeConfig>(
    () => MODE_CONFIGS.find((item) => item.value === mode)!,
    [mode]
  );

  const stepLabels = useMemo(() => {
    let nextStep = 1;
    return {
      mode: `Step ${nextStep++}`,
      inputs: `Step ${nextStep++}`,
      granularity: `Step ${nextStep++}`,
      estimated: activeMode.requiresEstimatedChunks
        ? `Step ${nextStep++}`
        : null,
      alignment: activeMode.requiresAlignmentModel
        ? `Step ${nextStep++}`
        : null,
      vad: activeMode.requiresVadModel ? `Step ${nextStep++}` : null,
      stt: activeMode.requiresSttModel ? `Step ${nextStep++}` : null,
      run: `Step ${nextStep++}`,
      result: `Step ${nextStep++}`,
    };
  }, [activeMode]);

  const derivedSubtitles = useMemo<DerivedSubtitleItem[]>(() => {
    if (!result) {
      return [];
    }
    return result.alignmentSegments
      .map((segment) => ({
        text: String(segment.payload?.text ?? '').trim(),
        startSec: segment.startSample / Math.max(1, segment.sampleRate),
        endSec: segment.endSample / Math.max(1, segment.sampleRate),
      }))
      .filter((item) => item.text.length > 0 && item.endSec >= item.startSec);
  }, [result]);

  const estimatedTimeline = useMemo(() => {
    if (mode !== 'estimated') {
      return {
        sampleRate: null,
        counts: [] as number[],
        error: null as string | null,
      };
    }
    try {
      const parsed = parseEstimatedTimeline(
        estimatedSampleRateText,
        estimatedSegmentCountsText
      );
      return {
        sampleRate: parsed.sampleRate,
        counts: parsed.segmentSampleCounts,
        error: null,
      };
    } catch (err) {
      return {
        sampleRate: null,
        counts: [] as number[],
        error:
          err instanceof Error ? err.message : 'Invalid estimated timeline.',
      };
    }
  }, [estimatedSampleRateText, estimatedSegmentCountsText, mode]);

  useEffect(() => {
    if (!activeMode.allowedGranularities.includes(granularity)) {
      setGranularity(activeMode.allowedGranularities[0] ?? 'sentence');
    }
  }, [activeMode, granularity]);

  const runBlockingIssues = useMemo(
    () =>
      collectRunBlockingIssues({
        modeRequirements: activeMode,
        granularity,
        hasAudio: preparedAudioBuffer != null,
        hasReferenceText: referenceTranscript.trim().length > 0,
        estimatedTimelineError: estimatedTimeline.error,
      }),
    [
      activeMode,
      collectRunBlockingIssues,
      estimatedTimeline.error,
      granularity,
      preparedAudioBuffer,
      referenceTranscript,
    ]
  );

  const handleRunAlignment = useCallback(async () => {
    if (runBlockingIssues.length > 0) {
      setError(
        runBlockingIssues[0] ??
          'Resolve the remaining pipeline requirements first.'
      );
      setErrorCode(null);
      return;
    }

    setRunning(true);
    setError(null);
    setErrorCode(null);
    setResult(null);

    let textBufferId: string | null = null;
    let outputSegmentBufferId: string | null = null;
    let anchorSegmentBufferId: string | null = null;
    let hypothesisTextBufferId: string | null = null;
    const audioBufferId = preparedAudioBuffer!.bufferId;

    try {
      const alignmentEngine = await alignment.ensureAlignmentEngine();
      const referenceBuffer = await createOfflineTextBufferFromText(
        referenceTranscript.trim()
      );
      textBufferId = referenceBuffer.bufferId;

      const outputBuffer = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: audioBufferId,
      });
      outputSegmentBufferId = outputBuffer.bufferId;

      const accurateAlignmentModel = activeMode.requiresAlignmentModel
        ? alignment.buildAccurateAlignmentModelArg()
        : null;
      if (activeMode.requiresAlignmentModel && !accurateAlignmentModel) {
        throw new Error('Alignment model is not prepared.');
      }

      if (activeMode.requiresVadModel) {
        const vadModelPath = await vad.resolvePreparedModelPath();
        const anchorRef = await segmentOfflineBuffer(audioBufferId, {
          evaluator: 'speech_vad_model',
          modelPath: vadModelPath,
        });
        anchorSegmentBufferId = anchorRef.segmentBufferId;
      }

      if (activeMode.requiresSttModel) {
        const sttEngine = stt.engineRef.current;
        if (!sttEngine) {
          throw new Error('STT engine is not initialized.');
        }
        const hypothesisBuffer = await createEmptyOfflineTextBuffer();
        hypothesisTextBufferId = hypothesisBuffer.bufferId;
        await sttEngine.transcribe(audioBufferId, hypothesisBuffer, {
          segmentation: { mode: 'off' },
        });
      }

      const writeStartedAt = Date.now();
      const textGranularity = granularity as 'sentence' | 'word';
      const writeResult =
        mode === 'proportional'
          ? await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'proportional',
                granularity: textGranularity,
              }
            )
          : mode === 'estimated'
          ? await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'estimated',
                granularity: textGranularity,
                chunks: {
                  sampleRate: estimatedTimeline.sampleRate!,
                  segmentSampleCounts: estimatedTimeline.counts,
                },
              }
            )
          : mode === 'accurate'
          ? await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'accurate',
                granularity,
                ...accurateAlignmentModel!,
              }
            )
          : mode === 'vad'
          ? await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'vad',
                granularity: textGranularity,
                segmentation: {
                  source: 'vad',
                  segmentBuffer: anchorSegmentBufferId!,
                },
              }
            )
          : mode === 'asr_mediated'
          ? await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'accurate',
                granularity: textGranularity,
                ...accurateAlignmentModel!,
                segmentation: {
                  mode: 'auto',
                  anchorSegmentBuffer: anchorSegmentBufferId!,
                  mappingStrategy: 'asr_mediated',
                  asr: {
                    hypothesisTextBuffer: hypothesisTextBufferId!,
                  },
                },
              }
            )
          : await alignmentEngine.alignTextToAudio(
              referenceBuffer,
              audioBufferId,
              outputBuffer,
              {
                mode: 'accurate',
                granularity: textGranularity,
                ...accurateAlignmentModel!,
                segmentation: {
                  mode: 'auto',
                  anchorSegmentBuffer: anchorSegmentBufferId!,
                  mappingStrategy: 'chunked_forced_ctc',
                },
              }
            );
      const writeDurationMs = Date.now() - writeStartedAt;
      const segments = await getOfflineSegmentBufferSegments(
        outputBuffer,
        0,
        4096
      );
      const alignmentSegments = segments.filter(
        (segment): segment is AlignmentSegmentView =>
          segment.kind === 'alignment'
      );

      setResult({
        mode,
        textInBufferId: referenceBuffer.bufferId,
        audioInBufferId: audioBufferId,
        outputSegmentBufferId: writeResult.outputSegmentBufferId,
        anchorSegmentBufferId: anchorSegmentBufferId ?? undefined,
        hypothesisTextBufferId: hypothesisTextBufferId ?? undefined,
        segmentsWritten: writeResult.segmentsWritten,
        writeDurationMs,
        warningCode: writeResult.warningCode,
        warnings: writeResult.warnings,
        alignmentSegments,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to run offline alignment pipeline.';
      setError(message);
      setErrorCode(extractErrorCode(message));
    } finally {
      if (hypothesisTextBufferId) {
        await releasePipelineTextBuffer(hypothesisTextBufferId).catch(() => {});
      }
      if (anchorSegmentBufferId) {
        await releasePipelineSegmentBuffer(anchorSegmentBufferId).catch(
          () => {}
        );
      }
      if (outputSegmentBufferId) {
        await releasePipelineSegmentBuffer(outputSegmentBufferId).catch(
          () => {}
        );
      }
      if (textBufferId) {
        await releasePipelineTextBuffer(textBufferId).catch(() => {});
      }
      setRunning(false);
    }
  }, [
    activeMode,
    alignment,
    estimatedTimeline.counts,
    estimatedTimeline.sampleRate,
    granularity,
    mode,
    preparedAudioBuffer,
    referenceTranscript,
    runBlockingIssues,
    stt.engineRef,
    vad,
  ]);

  const pipelineBusy = running;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <SectionCard
            stepLabel={stepLabels.mode}
            title="Choose offline alignment mode"
            description="Each mode below maps 1:1 to a documented public alignment path. There are no silent fallbacks between modes."
          >
            <View style={styles.modeGrid}>
              {MODE_CONFIGS.map((item) => {
                const isSelected = item.value === mode;
                return (
                  <Pressable
                    key={item.value}
                    style={[
                      styles.modeCard,
                      isSelected && styles.modeCardActive,
                    ]}
                    onPress={() => {
                      setMode(item.value);
                      setError(null);
                      setErrorCode(null);
                      setResult(null);
                    }}
                  >
                    <Text
                      style={[
                        styles.modeCardTitle,
                        isSelected && styles.modeCardTitleActive,
                      ]}
                    >
                      {item.title}
                    </Text>
                    <Text style={styles.modeCardDescription}>
                      {item.description}
                    </Text>
                    <View style={styles.modeMetaRow}>
                      {item.allowedGranularities.map((value) => (
                        <View
                          key={`${item.value}-${value}`}
                          style={styles.metaPill}
                        >
                          <Text style={styles.metaPillText}>{value}</Text>
                        </View>
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          <SectionCard
            stepLabel={stepLabels.inputs}
            title="Provide shared inputs"
            description="All public alignment modes consume the same offline audio base plus a reference transcript R. In asr_mediated, this reference remains separate from the ASR hypothesis buffer H."
          >
            <Text style={styles.inputLabel}>Audio file</Text>
            <View style={styles.hintCard}>
              <Ionicons
                name="information-circle-outline"
                size={18}
                color="#FF9800"
              />
              <Text style={styles.hintText}>
                Audio is loaded with createOfflineAudioBufferFromFile, which
                decodes common formats (WAV, MP3, M4A, FLAC, …) and resamples as
                needed. The same offline buffer is reused for anchors, STT, and
                final alignment.
              </Text>
            </View>
            <OfflineAudioBufferWidget
              ref={audioWidgetRef}
              audioFiles={AUDIO_FILES}
              disabled={pipelineBusy}
              onBufferReady={(info) => {
                setPreparedAudioBuffer(info);
                setResult(null);
              }}
              onBufferReleased={() => {
                setPreparedAudioBuffer(null);
                setResult(null);
              }}
            />

            <Text style={styles.inputLabel}>Reference transcript (R)</Text>
            <TextInput
              style={styles.textInput}
              value={referenceTranscript}
              onChangeText={setReferenceTranscript}
              placeholder="Enter the reference transcript that should align to audio"
              multiline
            />
            <Text style={styles.inlineHelpText}>
              This buffer is always the reference text. It is never reused as
              the ASR hypothesis in asr_mediated.
            </Text>
          </SectionCard>

          <SectionCard
            stepLabel={stepLabels.granularity}
            title="Choose valid granularity"
            description={activeMode.granularityHint}
          >
            <View style={styles.choiceList}>
              {ALL_GRANULARITIES.map((value) => {
                const disabledReason = getGranularityDisabledReason(
                  mode,
                  value
                );
                const isSelected = granularity === value;
                const disabled = disabledReason != null;
                return (
                  <Pressable
                    key={value}
                    style={[
                      styles.choiceCard,
                      isSelected && styles.choiceCardActive,
                      disabled && styles.choiceCardDisabled,
                    ]}
                    onPress={() => {
                      if (disabled) {
                        return;
                      }
                      setGranularity(value);
                    }}
                    disabled={disabled}
                  >
                    <Text
                      style={[
                        styles.choiceTitle,
                        isSelected && styles.choiceTitleActive,
                        disabled && styles.choiceTitleDisabled,
                      ]}
                    >
                      {value}
                    </Text>
                    <Text style={styles.choiceDescription}>
                      {value === 'sentence'
                        ? 'Generate one aligned unit per sentence.'
                        : value === 'word'
                        ? 'Generate one aligned unit per word.'
                        : 'Generate one aligned unit per character.'}
                    </Text>
                    {disabledReason ? (
                      <Text style={styles.choiceReason}>{disabledReason}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </SectionCard>

          {activeMode.requiresEstimatedChunks ? (
            <SectionCard
              stepLabel={stepLabels.estimated!}
              title="Provide estimated chunk timeline"
              description="Estimated mode consumes caller-provided segmentSampleCounts and sampleRate exactly as documented. No alignment ONNX is loaded for this path."
            >
              <Text style={styles.inputLabel}>Sample rate</Text>
              <TextInput
                style={styles.inlineInput}
                value={estimatedSampleRateText}
                onChangeText={setEstimatedSampleRateText}
                keyboardType="number-pad"
                placeholder="16000"
              />
              <Text style={styles.inputLabel}>segmentSampleCounts</Text>
              <TextInput
                style={styles.textInput}
                value={estimatedSegmentCountsText}
                onChangeText={setEstimatedSegmentCountsText}
                placeholder="3200, 4000, 2800"
                multiline
              />
              <Text style={styles.inlineHelpText}>
                Enter positive integers separated by commas, spaces, or new
                lines.
              </Text>
              {estimatedTimeline.error ? (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningBannerText}>
                    {estimatedTimeline.error}
                  </Text>
                </View>
              ) : (
                <View style={styles.currentModelContainer}>
                  <Text style={styles.currentModelText}>
                    Parsed {estimatedTimeline.counts.length} chunk values at{' '}
                    {estimatedTimeline.sampleRate} Hz
                  </Text>
                </View>
              )}
            </SectionCard>
          ) : null}

          <GenerateTimestampModelInitPanel
            init={modelInit}
            stepLabels={{
              alignment: stepLabels.alignment,
              vad: stepLabels.vad,
              stt: stepLabels.stt,
            }}
            requiresAlignmentModel={activeMode.requiresAlignmentModel}
            requiresVadModel={activeMode.requiresVadModel}
            requiresSttModel={activeMode.requiresSttModel}
            disabled={pipelineBusy}
            onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
          />

          <SectionCard
            stepLabel={stepLabels.run}
            title="Run offline alignment"
            description="Creates fresh offline buffers per run, executes the selected mode, reads alignment segments, then releases buffers. Cached alignment / STT engines stay alive for navigation."
          >
            <View style={styles.resultCard}>
              <Text style={styles.resultMetaText}>Pipeline summary</Text>
              <Text style={styles.resultCodeText}>
                mode: {activeMode.title}
              </Text>
              <Text style={styles.resultCodeText}>
                native mode: {activeMode.apiMode}
              </Text>
              <Text style={styles.resultCodeText}>
                granularity: {granularity}
              </Text>
              <Text style={styles.resultCodeText}>
                alignment init:{' '}
                {activeMode.requiresAlignmentModel
                  ? alignment.initMode
                  : 'not required'}
              </Text>
              <Text style={styles.resultCodeText}>
                alignment model:{' '}
                {activeMode.requiresAlignmentModel
                  ? alignment.isPrepared
                    ? alignment.initializedSummary ?? 'ready'
                    : 'missing'
                  : 'not required'}
              </Text>
              <Text style={styles.resultCodeText}>
                VAD model:{' '}
                {activeMode.requiresVadModel
                  ? vad.isPrepared
                    ? vad.initializedSummary ?? 'ready'
                    : 'missing'
                  : 'not required'}
              </Text>
              <Text style={styles.resultCodeText}>
                STT model:{' '}
                {activeMode.requiresSttModel
                  ? stt.isPrepared
                    ? stt.initializedSummary ?? 'ready'
                    : 'missing'
                  : 'not required'}
              </Text>
            </View>

            {runBlockingIssues.length > 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningBannerText}>
                  Resolve these inputs before running:
                </Text>
                {runBlockingIssues.map((issue) => (
                  <Text key={issue} style={styles.warningListItem}>
                    • {issue}
                  </Text>
                ))}
              </View>
            ) : (
              <View style={styles.readyCard}>
                <Ionicons name="checkmark-circle" size={18} color="#1B5E20" />
                <Text style={styles.readyText}>Pipeline is ready to run.</Text>
              </View>
            )}

            <Pressable
              style={[
                styles.button,
                styles.generateButton,
                (pipelineBusy || runBlockingIssues.length > 0) &&
                  styles.buttonDisabled,
              ]}
              onPress={handleRunAlignment}
              disabled={pipelineBusy || runBlockingIssues.length > 0}
            >
              {running ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>
                  {activeMode.runButtonLabel}
                </Text>
              )}
            </Pressable>
          </SectionCard>

          {error || errorCode ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>Pipeline error</Text>
              {errorCode ? (
                <Text style={styles.errorCode}>code: {errorCode}</Text>
              ) : null}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          ) : null}

          <SectionCard
            stepLabel={stepLabels.result}
            title="Result"
            description="The output shown here is derived from the alignment segments already read from segmentOut before buffer cleanup."
          >
            {result ? (
              <>
                <View style={styles.resultCard}>
                  <Text style={styles.resultMetaText}>Pipeline I/O</Text>
                  <Text style={styles.resultCodeText}>
                    textInBufferId: {result.textInBufferId}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    audioInBufferId: {result.audioInBufferId}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    outputSegmentBufferId: {result.outputSegmentBufferId}
                  </Text>
                  {result.anchorSegmentBufferId ? (
                    <Text style={styles.resultCodeText}>
                      anchorSegmentBufferId: {result.anchorSegmentBufferId}
                    </Text>
                  ) : null}
                  {result.hypothesisTextBufferId ? (
                    <Text style={styles.resultCodeText}>
                      hypothesisTextBufferId: {result.hypothesisTextBufferId}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Text style={styles.resultMetaText}>Write result</Text>
                  <Text style={styles.resultCodeText}>mode: {result.mode}</Text>
                  <Text style={styles.resultCodeText}>
                    segmentsWritten: {result.segmentsWritten}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    writeDurationMs: {formatMs(result.writeDurationMs)}
                  </Text>
                  <Text style={styles.resultCodeText}>
                    warningCode: {result.warningCode ?? 'none'}
                  </Text>
                  {result.warnings?.length ? (
                    <View style={styles.warningList}>
                      {result.warnings.map((warning) => (
                        <Text
                          key={`${warning.code}-${warning.message}`}
                          style={styles.resultCodeText}
                        >
                          {warning.code}: {warning.message}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Pressable
                    style={styles.resultAccordionHeader}
                    onPress={() => setSegmentsExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      Alignment segments ({result.alignmentSegments.length})
                    </Text>
                    <Ionicons
                      name={segmentsExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="#666"
                    />
                  </Pressable>
                  {segmentsExpanded ? (
                    result.alignmentSegments.length > 0 ? (
                      <View style={styles.subtitleList}>
                        {result.alignmentSegments.map((segment, index) => (
                          <View
                            key={`${segment.id}-${index}`}
                            style={styles.subtitleItem}
                          >
                            <Text style={styles.subtitleText}>
                              #{index + 1} [{segment.startSample} -{' '}
                              {segment.endSample}] ({segment.durationMs}ms)
                            </Text>
                            <Text style={styles.subtitleTime}>
                              {segment.payload?.text ?? '...'}
                            </Text>
                            <Text style={styles.subtitleTime}>
                              timingMode={segment.payload?.timingMode ?? 'n/a'}{' '}
                              granularity=
                              {segment.payload?.granularity ?? 'n/a'}
                            </Text>
                            {segment.payload?.tokenMetadata ? (
                              <Text style={styles.subtitleTime}>
                                mapping=
                                {String(
                                  segment.payload.tokenMetadata
                                    .mappingStrategy ?? 'n/a'
                                )}{' '}
                                units=
                                {String(
                                  segment.payload.tokenMetadata.textUnitCount ??
                                    'n/a'
                                )}{' '}
                                anchors=
                                {String(
                                  segment.payload.tokenMetadata
                                    .vadAnchorCount ?? 'n/a'
                                )}{' '}
                                minAnchors=
                                {String(
                                  segment.payload.tokenMetadata
                                    .minAnchorsApplied ?? 'n/a'
                                )}
                              </Text>
                            ) : null}
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        Output buffer completed successfully but wrote no
                        alignment segments.
                      </Text>
                    )
                  ) : null}
                </View>

                <View style={styles.resultCard}>
                  <Pressable
                    style={styles.resultAccordionHeader}
                    onPress={() => setSubtitlesExpanded((prev) => !prev)}
                  >
                    <Text style={styles.resultMetaText}>
                      Derived subtitles ({derivedSubtitles.length})
                    </Text>
                    <Ionicons
                      name={subtitlesExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="#666"
                    />
                  </Pressable>
                  {subtitlesExpanded ? (
                    derivedSubtitles.length > 0 ? (
                      <View style={styles.subtitleList}>
                        {derivedSubtitles.map((subtitle, index) => (
                          <View
                            key={`subtitle-${index}-${subtitle.startSec}`}
                            style={styles.subtitleItem}
                          >
                            <Text style={styles.subtitleText}>
                              #{index + 1} [{subtitle.startSec.toFixed(2)}s -{' '}
                              {subtitle.endSec.toFixed(2)}s]
                            </Text>
                            <Text style={styles.subtitleTime}>
                              {subtitle.text}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        No derived subtitles available.
                      </Text>
                    )
                  ) : null}
                </View>
              </>
            ) : (
              <Text style={styles.emptyText}>
                No output yet. Run one documented offline alignment mode to
                populate the result cards.
              </Text>
            )}
          </SectionCard>
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="GenerateTimestamp" />
    </SafeAreaView>
  );
}
