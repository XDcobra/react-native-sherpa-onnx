import { useState, useMemo, useRef, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { styles } from './STTScreen.styles';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAudioFilesForModel } from '../../audioConfig';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
} from '../../components/OfflineAudioBufferWidget';
import { OfflineTextBufferResultCard } from '../../components/OfflineTextBufferResultCard';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { SttModelInitPanel } from '../../components/SttModelInitPanel';
import {
  formatSttInitError,
  useSttModelInit,
} from '../../hooks/useSttModelInit';
import {
  readOfflineTextBufferSnapshot,
  type OfflineTextBufferSnapshot,
} from '../../utils/readOfflineTextBufferSnapshot';

type SttOfflineTextBufferState = OfflineTextBufferSnapshot & {
  createdAt: number;
};

let gSttOfflineInputBuffer: OfflineAudioBufferInfo | null = null;
let gSttOfflineTextBuffers: SttOfflineTextBufferState[] = [];

export default function STTScreen() {
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );
  const stt = useSttModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const [transcriptionResult, setTranscriptionResult] =
    useState<OfflineTextBufferSnapshot | null>(null);
  const [offlineTextBuffers, setOfflineTextBuffers] = useState<
    SttOfflineTextBufferState[]
  >(gSttOfflineTextBuffers);
  const [transcribing, setTranscribing] = useState(false);
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(gSttOfflineInputBuffer);
  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  const {
    engineRef,
    currentModelFolder,
    selectedModelType,
    detectedModels,
    loading,
    isEngineInitialized,
  } = stt;

  const availableAudioFiles = useMemo(
    () => (currentModelFolder ? getAudioFilesForModel(currentModelFolder) : []),
    [currentModelFolder]
  );

  const hasTypeSection = detectedModels.length > 0;
  const transcribeSectionNum = hasTypeSection ? 3 : 2;
  const resultSectionNum = transcribeSectionNum + 1;

  onBeforeInitRef.current = () => {
    setTranscriptionResult(null);
    setTranscribeError(null);
  };

  const appendOfflineTextBuffer = useCallback(
    (result: SttOfflineTextBufferState) => {
      setOfflineTextBuffers((prev) => {
        const next = [
          ...prev.filter((item) => item.bufferId !== result.bufferId),
          result,
        ];
        gSttOfflineTextBuffers = next;
        return next;
      });
    },
    []
  );

  const removeOfflineTextBuffer = useCallback(async (bufferId: string) => {
    await releasePipelineTextBuffer(bufferId).catch(() => {});
    let nextBuffers: SttOfflineTextBufferState[] = [];
    setOfflineTextBuffers((prev) => {
      nextBuffers = prev.filter((item) => item.bufferId !== bufferId);
      gSttOfflineTextBuffers = nextBuffers;
      return nextBuffers;
    });
    setTranscriptionResult((prev) => {
      if (prev?.bufferId !== bufferId) return prev;
      if (nextBuffers.length === 0) return null;
      return nextBuffers[nextBuffers.length - 1] ?? null;
    });
  }, []);

  const handleTranscribe = async () => {
    if (!selectedModelType) {
      setTranscribeError('Please initialize a model first');
      return;
    }

    if (!offlineInputBuffer) {
      setTranscribeError(
        'Please select an audio source and create an OfflineAudioBuffer first'
      );
      return;
    }

    setTranscribing(true);
    setTranscribeError(null);
    setTranscriptionResult(null);

    try {
      const engine = engineRef.current;
      if (!engine) {
        setTranscribeError('STT engine not initialized');
        return;
      }

      const textRef = await createEmptyOfflineTextBuffer();
      const textBufferId = textRef.bufferId;
      let keepTextBuffer = false;
      try {
        const segOption = buildSegmentationOption(segConfig);
        await engine.transcribe(offlineInputBuffer.bufferId as any, textRef, {
          segmentation: segOption,
        });

        const snapshot = await readOfflineTextBufferSnapshot(textBufferId);
        const nextResult: SttOfflineTextBufferState = {
          ...snapshot,
          createdAt: Date.now(),
        };
        setTranscriptionResult(nextResult);
        appendOfflineTextBuffer(nextResult);
        keepTextBuffer = true;
      } finally {
        if (!keepTextBuffer) {
          await releasePipelineTextBuffer(textBufferId).catch(() => {});
        }
      }
    } catch (err) {
      const msg =
        (err instanceof Error ? err.message : (err as any)?.message) ?? '';
      if (msg.includes('cache_last_time')) {
        const friendly =
          'This model appears to be a NeMo streaming transducer (e.g. "streaming fast conformer"). File transcription currently requires a non-streaming NeMo transducer model. Please use a model exported for offline/non-streaming use, or choose another STT model.';
        Alert.alert('Transcription not supported', friendly);
        setTranscribeError(friendly);
        return;
      }

      setTranscribeError(formatSttInitError(err));
    } finally {
      setTranscribing(false);
    }
  };

  const handleFree = async () => {
    await stt.releaseEngine();
    const prevBuf = gSttOfflineInputBuffer;
    gSttOfflineInputBuffer = null;
    setOfflineInputBuffer(null);
    if (prevBuf?.bufferId) {
      await releasePipelineAudioBuffer(prevBuf.bufferId).catch(() => {});
    }
    setTranscriptionResult(null);
    const textBuffersToRelease = gSttOfflineTextBuffers;
    gSttOfflineTextBuffers = [];
    setOfflineTextBuffers([]);
    for (const item of textBuffersToRelease) {
      await releasePipelineTextBuffer(item.bufferId).catch(() => {});
    }
    setTranscribeError(null);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
        >
          {isEngineInitialized && (
            <TouchableOpacity
              style={styles.freeButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.freeButtonText}>Release model</Text>
            </TouchableOpacity>
          )}

          <SttModelInitPanel stt={stt} />

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {transcribeSectionNum}. Transcribe Audio
            </Text>
            <Text style={styles.hint}>
              Select an audio source, create an OfflineAudioBuffer once, and
              transcribe it using the selected model.
            </Text>
            <Text style={styles.hint}>
              SDK note: remember to release pipeline buffers when they are no
              longer needed to avoid memory leaks.
            </Text>

            {!selectedModelType && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Please initialize a model first
                </Text>
              </View>
            )}

            {selectedModelType && (
              <OfflineAudioBufferWidget
                audioFiles={availableAudioFiles}
                disabled={transcribing || loading}
                onBufferReady={(info) => {
                  gSttOfflineInputBuffer = info;
                  setOfflineInputBuffer(info);
                  setTranscriptionResult(null);
                  setTranscribeError(null);
                }}
                onBufferReleased={() => {
                  gSttOfflineInputBuffer = null;
                  setOfflineInputBuffer(null);
                }}
              />
            )}

            {selectedModelType && offlineInputBuffer && (
              <>
                <SegmentationPolicyControls
                  variant="speech-offline"
                  value={segConfig}
                  onChange={setSegConfig}
                  disabled={transcribing || loading}
                />
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.mt12,
                    (transcribing || loading) && styles.buttonDisabled,
                  ]}
                  onPress={handleTranscribe}
                  disabled={transcribing || loading}
                >
                  {transcribing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Transcribe Audio</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {transcribeError ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{transcribeError}</Text>
              </View>
            ) : null}
          </View>

          {selectedModelType &&
          (transcriptionResult != null || offlineTextBuffers.length > 0) ? (
            <OfflineTextBufferResultCard
              title={`${resultSectionNum}. Result`}
              hint="Transcription output is stored in OfflineTextBuffers. Remove buffers you no longer need to release memory."
              result={transcriptionResult}
              buffers={offlineTextBuffers}
              onSelectBuffer={(bufferId) => {
                const found = offlineTextBuffers.find(
                  (b) => b.bufferId === bufferId
                );
                if (found) setTranscriptionResult(found);
              }}
              onRemoveBuffer={(bufferId) => {
                removeOfflineTextBuffer(bufferId).catch(() => {});
              }}
            />
          ) : null}
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="STT" />
    </SafeAreaView>
  );
}
