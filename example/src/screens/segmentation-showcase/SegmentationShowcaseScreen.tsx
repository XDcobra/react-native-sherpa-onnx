import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  getSegmentCount,
  getSegments,
  segmentOfflineBuffer,
  type SpeechSegment,
  type TextSegment,
} from 'react-native-sherpa-onnx/segment';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { AUDIO_FILES } from '../../audioConfig';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  getColorForSegmentReason,
  SEGMENT_REASON_BADGE_LABEL_COLOR,
} from './segmentReasonColors';
import { styles } from './SegmentationShowcaseScreen.styles';

type Mode = 'text' | 'audio';

const EXAMPLE_TEXT =
  'Hello world. This is a longer example text that will be segmented. The segmentation engine cuts text at sentence boundaries and respects length limits. You can adjust parameters to see how segments change.';
const SEGMENT_PAGE_SIZE = 128;

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return 'Unknown error';
}

function payloadSourceLabel(segment: SpeechSegment): string | null {
  const payload = segment.meta?.payload;
  if (payload == null || typeof payload !== 'object') {
    return null;
  }
  const source = (payload as { source?: unknown }).source;
  return typeof source === 'string' && source.length > 0 ? source : null;
}

export default function SegmentationShowcaseScreen() {
  const [mode, setMode] = useState<Mode>('text');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMoreSegments, setLoadingMoreSegments] = useState(false);

  const [inputText, setInputText] = useState(EXAMPLE_TEXT);
  const [textSegments, setTextSegments] = useState<TextSegment[]>([]);
  const [textTotalSegmentCount, setTextTotalSegmentCount] = useState<
    number | null
  >(null);

  const [audioSegments, setAudioSegments] = useState<SpeechSegment[]>([]);
  const [audioTotalSegmentCount, setAudioTotalSegmentCount] = useState<
    number | null
  >(null);

  const [textSegConfig, setTextSegConfig] = useState<SegmentationControlConfig>({
    mode: 'auto',
    policy: {
      evaluator: 'text_synthetic_auto',
      maxLengthChars: 100,
      sentenceBoundary: true,
    },
  });
  const [audioSegConfig, setAudioSegConfig] =
    useState<SegmentationControlConfig>({
      mode: 'auto',
      policy: {
        evaluator: 'speech_energy_silence',
        silenceThresholdMs: 500,
        energyThresholdDb: -40,
        minSegmentMs: 1000,
        maxSegmentMs: 30000,
        hangoverMs: 300,
      },
    });

  const [preparedAudioBuffer, setPreparedAudioBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const audioWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  const textBufferRef = useRef<string | null>(null);
  const audioBufferRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (textBufferRef.current) {
        releasePipelineTextBuffer(textBufferRef.current).catch(() => {});
        textBufferRef.current = null;
      }
      if (audioBufferRef.current) {
        releasePipelineAudioBuffer(audioBufferRef.current).catch(() => {});
        audioBufferRef.current = null;
      }
    };
  }, []);

  const handleRunTextSegmentation = useCallback(async () => {
    if (!inputText.trim()) {
      setError('Please enter some text');
      return;
    }
    if (textSegConfig.mode !== 'auto' || !textSegConfig.policy) {
      setError('Enable auto mode with an evaluator policy.');
      return;
    }
    if (
      textSegConfig.policy.evaluator === 'text_punctuation_assisted' &&
      !textSegConfig.policy.punctuationInstanceId
    ) {
      setError(
        'Initialize a punctuation model first. This evaluator requires policy.punctuationInstanceId.'
      );
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
      }

      const textBuffer = await createOfflineTextBufferFromText(inputText);
      textBufferRef.current = textBuffer.bufferId;

      await segmentOfflineBuffer(textBuffer, textSegConfig.policy);

      const segments = (await getSegments(
        textBuffer,
        0,
        SEGMENT_PAGE_SIZE
      )) as TextSegment[];
      const totalSegmentCount = await getSegmentCount(textBuffer);
      setTextSegments(segments);
      setTextTotalSegmentCount(totalSegmentCount);
    } catch (err) {
      setError(`Text segmentation failed: ${normalizeErrorMessage(err)}`);
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
        textBufferRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  }, [inputText, textSegConfig.mode, textSegConfig.policy]);

  const handleRunAudioSegmentation = useCallback(async () => {
    if (!preparedAudioBuffer) {
      setError('Please select an audio file');
      return;
    }
    if (audioSegConfig.mode !== 'auto' || !audioSegConfig.policy) {
      setError('Enable auto mode with an evaluator policy.');
      return;
    }

    const policy = audioSegConfig.policy;
    if (
      (policy.evaluator === 'speech_vad_model' ||
        policy.evaluator === 'speech_pyannote_segmentation') &&
      !(policy as { modelPath?: unknown }).modelPath
    ) {
      setError(
        'Select and detect a model first. This evaluator requires policy.modelPath.'
      );
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const audioBufferId = preparedAudioBuffer.bufferId;
      audioBufferRef.current = audioBufferId;

      await segmentOfflineBuffer(audioBufferId, policy);

      const segments = (await getSegments(
        audioBufferId,
        0,
        SEGMENT_PAGE_SIZE
      )) as SpeechSegment[];
      const totalSegmentCount = await getSegmentCount(audioBufferId);
      setAudioSegments(segments);
      setAudioTotalSegmentCount(totalSegmentCount);
    } catch (err) {
      setError(`Audio segmentation failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [preparedAudioBuffer, audioSegConfig.mode, audioSegConfig.policy]);

  const handleLoadMoreTextSegments = useCallback(async () => {
    const bufferId = textBufferRef.current;
    if (!bufferId || loadingMoreSegments) return;
    const start = textSegments.length;
    const total = textTotalSegmentCount;
    if (total == null || start >= total) return;

    setLoadingMoreSegments(true);
    setError(null);
    try {
      const more = (await getSegments(
        bufferId,
        start,
        SEGMENT_PAGE_SIZE
      )) as TextSegment[];
      setTextSegments((prev) => [...prev, ...more]);
    } catch (err) {
      setError(`Load more segments failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoadingMoreSegments(false);
    }
  }, [loadingMoreSegments, textSegments.length, textTotalSegmentCount]);

  const handleLoadMoreAudioSegments = useCallback(async () => {
    const bufferId = audioBufferRef.current;
    if (!bufferId || loadingMoreSegments) return;
    const start = audioSegments.length;
    const total = audioTotalSegmentCount;
    if (total == null || start >= total) return;

    setLoadingMoreSegments(true);
    setError(null);
    try {
      const more = (await getSegments(
        bufferId,
        start,
        SEGMENT_PAGE_SIZE
      )) as SpeechSegment[];
      setAudioSegments((prev) => [...prev, ...more]);
    } catch (err) {
      setError(`Load more segments failed: ${normalizeErrorMessage(err)}`);
    } finally {
      setLoadingMoreSegments(false);
    }
  }, [loadingMoreSegments, audioSegments.length, audioTotalSegmentCount]);

  const textPolicy = textSegConfig.policy;
  const audioPolicy = audioSegConfig.policy;

  const canRunTextSegmentation =
    !loading &&
    inputText.trim().length > 0 &&
    textSegConfig.mode === 'auto' &&
    !!textPolicy &&
    (textPolicy.evaluator === 'text_synthetic_auto' ||
      (textPolicy.evaluator === 'text_punctuation_assisted' &&
        !!textPolicy.punctuationInstanceId));

  const canRunAudioSegmentation =
    !loading &&
    !!preparedAudioBuffer &&
    audioSegConfig.mode === 'auto' &&
    !!audioPolicy &&
    (audioPolicy.evaluator === 'speech_energy_silence' ||
      ((audioPolicy.evaluator === 'speech_vad_model' ||
        audioPolicy.evaluator === 'speech_pyannote_segmentation') &&
        !!(audioPolicy as { modelPath?: unknown }).modelPath));

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
      >
        <View style={styles.modeSelector}>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'text' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('text');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'text' ? 'document-text' : 'document-text-outline'}
              size={20}
              color={mode === 'text' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'text' && styles.modeButtonTextActive,
              ]}
            >
              Text
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'audio' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('audio');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'audio' ? 'volume-high' : 'volume-high-outline'}
              size={20}
              color={mode === 'audio' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'audio' && styles.modeButtonTextActive,
              ]}
            >
              Audio
            </Text>
          </Pressable>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {mode === 'text' && (
          <View style={styles.modeContent}>
            <View>
              <Text style={styles.sectionTitle}>Text Input</Text>
              <Text style={styles.sectionDescription}>
                Offline text segmentation supports synthetic boundaries or a
                loaded punctuation instance.
              </Text>
              <TextInput
                style={styles.textInput}
                multiline
                placeholder="Enter text to segment..."
                placeholderTextColor="#999"
                value={inputText}
                onChangeText={setInputText}
                editable={!loading}
              />
            </View>

            <View>
              <Text style={styles.sectionTitle}>Segmentation Policy</Text>
              <SegmentationPolicyControls
                variant="text-offline"
                value={textSegConfig}
                onChange={setTextSegConfig}
                disabled={loading}
                disableOff
                offDisabledMessage="This showcase always runs segmentOfflineBuffer and requires an evaluator policy."
              />
            </View>

            <Pressable
              style={[
                styles.button,
                (!canRunTextSegmentation || loading) && styles.buttonDisabled,
              ]}
              onPress={handleRunTextSegmentation}
              disabled={!canRunTextSegmentation}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Text</Text>
                </>
              )}
            </Pressable>

            {textSegments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Segments ({textSegments.length}
                  {textTotalSegmentCount != null &&
                  textTotalSegmentCount > textSegments.length
                    ? ` of ${textTotalSegmentCount}`
                    : ''}
                  )
                </Text>
                <FlatList
                  data={textSegments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => {
                    const reasonColor = getColorForSegmentReason(item.reason);
                    return (
                      <View key={item.segmentId} style={styles.segmentCard}>
                        <View style={styles.segmentHeader}>
                          <Text style={styles.segmentIndex}>#{index + 1}</Text>
                          <View
                            style={[
                              styles.reasonBadge,
                              { backgroundColor: reasonColor },
                            ]}
                          >
                            <Text
                              style={[
                                styles.reasonBadgeText,
                                { color: SEGMENT_REASON_BADGE_LABEL_COLOR },
                              ]}
                            >
                              {item.reason}
                            </Text>
                          </View>
                          <Text style={styles.segmentMeta}>
                            {item.utf16Length} chars
                          </Text>
                        </View>
                        <Text style={styles.segmentText}>{item.text}</Text>
                      </View>
                    );
                  }}
                  keyExtractor={(item) => item.segmentId}
                />
                {textTotalSegmentCount != null &&
                  textSegments.length < textTotalSegmentCount && (
                    <Pressable
                      style={[
                        styles.button,
                        styles.secondaryButton,
                        styles.showMoreSegmentsButton,
                        (loading || loadingMoreSegments) &&
                          styles.buttonDisabled,
                      ]}
                      onPress={handleLoadMoreTextSegments}
                      disabled={loading || loadingMoreSegments}
                    >
                      {loadingMoreSegments ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Text style={styles.buttonText}>
                          Show more (
                          {Math.min(
                            SEGMENT_PAGE_SIZE,
                            textTotalSegmentCount - textSegments.length
                          )}{' '}
                          more)
                        </Text>
                      )}
                    </Pressable>
                  )}
              </>
            )}
          </View>
        )}

        {mode === 'audio' && (
          <View style={styles.modeContent}>
            <View>
              <Text style={styles.sectionTitle}>Audio Input</Text>
              <Text style={styles.sectionDescription}>
                Prepare an offline audio buffer, then run{' '}
                <Text style={{ fontWeight: '600' }}>segmentOfflineBuffer</Text>{' '}
                with the policy below. continuous_frames is live-only and is not
                listed for this offline variant.
              </Text>
              <OfflineAudioBufferWidget
                ref={audioWidgetRef}
                audioFiles={AUDIO_FILES}
                disabled={loading}
                onBufferReady={(info) => {
                  setPreparedAudioBuffer(info);
                  setAudioSegments([]);
                  setAudioTotalSegmentCount(null);
                  setError(null);
                }}
                onBufferReleased={() => {
                  setPreparedAudioBuffer(null);
                  setAudioSegments([]);
                  setAudioTotalSegmentCount(null);
                }}
              />
            </View>

            <View>
              <Text style={styles.sectionTitle}>Segmentation Policy</Text>
              <SegmentationPolicyControls
                variant="speech-offline"
                value={audioSegConfig}
                onChange={setAudioSegConfig}
                disabled={loading}
                disableOff
                offDisabledMessage="This showcase always runs segmentOfflineBuffer and requires an evaluator policy."
              />
            </View>

            <Pressable
              style={[
                styles.button,
                (!canRunAudioSegmentation || loading) && styles.buttonDisabled,
              ]}
              onPress={handleRunAudioSegmentation}
              disabled={!canRunAudioSegmentation}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Audio</Text>
                </>
              )}
            </Pressable>

            {audioSegments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Timeline ({audioSegments.length}
                  {audioTotalSegmentCount != null &&
                  audioTotalSegmentCount > audioSegments.length
                    ? ` of ${audioTotalSegmentCount}`
                    : ''}{' '}
                  segments)
                </Text>
                <View style={styles.timelineContainer}>
                  <View style={styles.timeline}>
                    {audioSegments.map((segment) => {
                      const totalDuration = audioSegments.reduce(
                        (sum, current) => sum + current.durationMs,
                        0
                      );
                      const width =
                        totalDuration > 0
                          ? (segment.durationMs / totalDuration) * 100
                          : 0;
                      const color = getColorForSegmentReason(segment.reason);

                      return (
                        <View
                          key={segment.segmentId}
                          style={[
                            styles.timelineSegment,
                            { width: `${width}%`, backgroundColor: color },
                          ]}
                          accessibilityLabel={`${segment.reason}: ${segment.durationMs}ms`}
                        />
                      );
                    })}
                  </View>
                </View>

                <FlatList
                  data={audioSegments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => {
                    const reasonColor = getColorForSegmentReason(item.reason);
                    const payloadSource = payloadSourceLabel(item);
                    return (
                      <View key={item.segmentId} style={styles.segmentCard}>
                        <View style={styles.segmentHeader}>
                          <Text style={styles.segmentIndex}>#{index + 1}</Text>
                          <View
                            style={[
                              styles.reasonBadge,
                              { backgroundColor: reasonColor },
                            ]}
                          >
                            <Text
                              style={[
                                styles.reasonBadgeText,
                                { color: SEGMENT_REASON_BADGE_LABEL_COLOR },
                              ]}
                            >
                              {item.reason}
                            </Text>
                          </View>
                          <Text style={styles.segmentMeta}>
                            {item.durationMs}ms
                          </Text>
                        </View>
                        {item.energy !== undefined && (
                          <Text style={styles.segmentDetail}>
                            Energy: {item.energy.toFixed(2)} dB
                          </Text>
                        )}
                        {item.vadInfo && (
                          <Text style={styles.segmentDetail}>
                            VAD: {item.vadInfo.decision || 'unknown'}
                          </Text>
                        )}
                        {payloadSource ? (
                          <Text style={styles.segmentDetail}>
                            Payload source: {payloadSource}
                          </Text>
                        ) : null}
                      </View>
                    );
                  }}
                  keyExtractor={(item) => item.segmentId}
                />
                {audioTotalSegmentCount != null &&
                  audioSegments.length < audioTotalSegmentCount && (
                    <Pressable
                      style={[
                        styles.button,
                        styles.secondaryButton,
                        styles.showMoreSegmentsButton,
                        (loading || loadingMoreSegments) &&
                          styles.buttonDisabled,
                      ]}
                      onPress={handleLoadMoreAudioSegments}
                      disabled={loading || loadingMoreSegments}
                    >
                      {loadingMoreSegments ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Text style={styles.buttonText}>
                          Show more (
                          {Math.min(
                            SEGMENT_PAGE_SIZE,
                            audioTotalSegmentCount - audioSegments.length
                          )}{' '}
                          more)
                        </Text>
                      )}
                    </Pressable>
                  )}
              </>
            )}
          </View>
        )}
      </ScrollView>
      <ScreenIntroModal screenId="SegmentationShowcase" />
    </SafeAreaView>
  );
}
