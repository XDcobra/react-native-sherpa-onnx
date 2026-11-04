import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { PunctuationPipelineHandle } from 'react-native-sherpa-onnx/punctuation';
import { PunctuationStreamingModelInitPanel } from '../../components/PunctuationStreamingModelInitPanel';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { usePunctuationStreamingModelInit } from '../../hooks/usePunctuationStreamingModelInit';
import { formatPunctuationInitError } from '../../hooks/usePunctuationModelInit';
import { styles } from '../stt/STTScreen.styles';
import { puncStyles } from '../punctuation/PunctuationScreen.styles';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const DEFAULT_STREAMING_TEXT =
  'hello world\nthis is streaming punctuation\nit writes live text segments';

export default function PunctuationStreamingScreen() {
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );
  const punctuation = usePunctuationStreamingModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const [inputText, setInputText] = useState(DEFAULT_STREAMING_TEXT);
  const [streamingSegConfig, setStreamingSegConfig] =
    useState<SegmentationControlConfig>({
      mode: 'auto',
      policy: {
        evaluator: 'text_punctuation_assisted',
        sentenceBoundary: true,
        maxLengthChars: 500,
      },
    });
  const [runBusy, setRunBusy] = useState(false);
  const [outputText, setOutputText] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const handleRef = useRef<PunctuationPipelineHandle | null>(null);
  const inputRef = useRef<LiveTextBufferRef | null>(null);
  const outputRef = useRef<LiveTextBufferRef | null>(null);

  const {
    engineRef,
    loading,
    isEngineInitialized,
    loadingModels,
    catalogEntries,
  } = punctuation;

  const releasePipelineResources = useCallback(async () => {
    if (handleRef.current) {
      await handleRef.current.stop().catch(() => {});
      handleRef.current = null;
    }
    if (inputRef.current) {
      await releasePipelineTextBuffer(inputRef.current).catch(() => {});
      inputRef.current = null;
    }
    if (outputRef.current) {
      await releasePipelineTextBuffer(outputRef.current).catch(() => {});
      outputRef.current = null;
    }
  }, []);

  onBeforeInitRef.current = async () => {
    setOutputText('');
    setStatusText(null);
    setRunError(null);
    await releasePipelineResources();
  };

  useEffect(() => {
    return () => {
      releasePipelineResources().catch(() => {});
    };
  }, [releasePipelineResources]);

  const handleFree = async () => {
    await releasePipelineResources();
    await punctuation.releaseEngine();
    setOutputText('');
    setStatusText(null);
    setRunError(null);
  };

  const runStreamingPunctuation = async () => {
    const engine = engineRef.current;
    if (!engine) {
      Alert.alert('Engine', 'Load a model first (Initialize).');
      return;
    }
    const text = inputText.trim();
    if (!text) {
      Alert.alert('Text', 'Enter text to stream.');
      return;
    }

    setRunBusy(true);
    setRunError(null);
    setOutputText('');
    setStatusText(null);

    try {
      await releasePipelineResources();

      const input = await createLiveTextBuffer();
      const output = await createLiveTextBuffer();
      inputRef.current = input;
      outputRef.current = output;

      const handle = await engine.punctuate(input, output, {
        segmentation: buildSegmentationOption(streamingSegConfig),
      });
      handleRef.current = handle;

      const chunks = text
        .split(/\n+/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      for (const chunk of chunks) {
        await appendLiveTextSegment(input, chunk);
      }
      await finalizeLiveTextBuffer(input);
      await handle.flush();
      await handle.stop();
      await handle.completed;

      const segments = await getLiveTextBufferSegments(output, 0, 100, {
        includeMeta: true,
      });
      setOutputText(segments.map((segment) => segment.text).join('\n'));
      const status = await handle.getStatus().catch(() => null);
      setStatusText(
        status
          ? `${segments.length} output segments, ${status.unitsRead} chars read, ${status.unitsWritten} chars written`
          : `${segments.length} output segments`
      );
      handleRef.current = null;
    } catch (e) {
      setRunError(formatPunctuationInitError(e));
    } finally {
      setRunBusy(false);
    }
  };

  const canShowWorkflow =
    !loadingModels && (catalogEntries.length > 0 || isEngineInitialized);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Online punctuation model</Text>
          <Text style={styles.hint}>
            Model directory must be a streaming CNN-BiLSTM layout. Flow: create
            live text input and output buffers, stream text segments, finalize
            input, flush the pipeline, then read the output buffer. Re-running
            releases previous buffers and allocates new ones.
          </Text>
        </View>

        {isEngineInitialized ? (
          <TouchableOpacity
            style={styles.freeButton}
            onPress={handleFree}
            disabled={loading || runBusy}
          >
            <Text style={styles.freeButtonText}>Release model</Text>
          </TouchableOpacity>
        ) : null}

        <PunctuationStreamingModelInitPanel
          punctuation={punctuation}
          disabled={runBusy}
        />

        {canShowWorkflow && (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>3. Live text input</Text>
              <TextInput
                style={[puncStyles.optionInput, puncStyles.multilineInput]}
                multiline
                value={inputText}
                onChangeText={setInputText}
                editable={!runBusy}
              />
              <SegmentationPolicyControls
                variant="text-streaming"
                value={streamingSegConfig}
                onChange={setStreamingSegConfig}
                disabled={runBusy}
              />
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                4. Run (live buffer → live buffer)
              </Text>
              <TouchableOpacity
                style={[
                  styles.button,
                  (runBusy || !isEngineInitialized) && styles.buttonDisabled,
                ]}
                disabled={runBusy || !isEngineInitialized}
                onPress={runStreamingPunctuation}
              >
                {runBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>
                    Run streaming punctuation
                  </Text>
                )}
              </TouchableOpacity>
              {statusText ? (
                <Text style={[styles.hint, puncStyles.hintAfterAction]}>
                  {statusText}
                </Text>
              ) : null}
            </View>

            {runError ? (
              <View style={styles.section}>
                <Text style={puncStyles.errorText}>{runError}</Text>
              </View>
            ) : null}

            <View style={styles.resultSection}>
              <Text style={styles.resultLabel}>Punctuated live output</Text>
              <Text style={puncStyles.outputReadonly}>{outputText}</Text>
            </View>
          </>
        )}
      </ScrollView>
      <ScreenIntroModal screenId="PunctuationStreaming" />
    </SafeAreaView>
  );
}
