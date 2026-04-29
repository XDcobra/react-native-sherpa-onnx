import { useEffect, useRef, useState } from 'react';
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
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createStreamingPunctuation,
  type PunctuationPipelineHandle,
  type StreamingPunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import { styles } from '../stt/STTScreen.styles';
import { puncStyles } from '../punctuation/PunctuationScreen.styles';

const DEFAULT_STREAMING_TEXT =
  'hello world\nthis is streaming punctuation\nit writes live text segments';

export default function PunctuationStreamingScreen() {
  const [modelPath, setModelPath] = useState('');
  const [inputText, setInputText] = useState(DEFAULT_STREAMING_TEXT);
  const [segmentationAuto, setSegmentationAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outputText, setOutputText] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<StreamingPunctuationEngine | null>(null);
  const handleRef = useRef<PunctuationPipelineHandle | null>(null);
  const inputRef = useRef<LiveTextBufferRef | null>(null);
  const outputRef = useRef<LiveTextBufferRef | null>(null);

  const cleanup = async () => {
    if (handleRef.current) {
      await handleRef.current.stop().catch(() => {});
      handleRef.current = null;
    }
    if (engineRef.current) {
      await engineRef.current.destroy().catch(() => {});
      engineRef.current = null;
    }
    if (inputRef.current) {
      await releasePipelineTextBuffer(inputRef.current).catch(() => {});
      inputRef.current = null;
    }
    if (outputRef.current) {
      await releasePipelineTextBuffer(outputRef.current).catch(() => {});
      outputRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, []);

  const runStreamingPunctuation = async () => {
    const path = modelPath.trim();
    if (!path) {
      Alert.alert(
        'Model path',
        'Enter an online CNN-BiLSTM punctuation model folder.'
      );
      return;
    }
    const text = inputText.trim();
    if (!text) {
      Alert.alert('Text', 'Enter text to stream.');
      return;
    }

    setBusy(true);
    setError(null);
    setOutputText('');
    setStatusText(null);

    try {
      await cleanup();
      const engine = await createStreamingPunctuation({
        modelPath: { type: 'file', path },
        modelType: 'auto',
        provider: 'cpu',
      });
      engineRef.current = engine;

      const input = await createLiveTextBuffer();
      const output = await createLiveTextBuffer();
      inputRef.current = input;
      outputRef.current = output;

      const handle = await engine.punctuate(input, output, {
        segmentation: segmentationAuto ? { mode: 'auto' } : { mode: 'off' },
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Online punctuation model</Text>
          <TextInput
            style={puncStyles.optionInput}
            value={modelPath}
            onChangeText={setModelPath}
            autoCapitalize="none"
            placeholder="/path/to/cnn-bilstm-punctuation-model"
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Live text input</Text>
          <TextInput
            style={[puncStyles.optionInput, puncStyles.multilineInput]}
            multiline
            value={inputText}
            onChangeText={setInputText}
          />
          <View style={puncStyles.debugRow}>
            <Text style={puncStyles.smallLabel}>attach segmentation </Text>
            <TouchableOpacity
              onPress={() => setSegmentationAuto((v) => !v)}
              accessibilityRole="button"
            >
              <Ionicons
                name={segmentationAuto ? 'checkbox' : 'square-outline'}
                size={24}
                color={segmentationAuto ? '#007AFF' : '#8E8E93'}
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.button, busy && styles.buttonDisabled]}
            disabled={busy}
            onPress={runStreamingPunctuation}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Run streaming punctuation</Text>
            )}
          </TouchableOpacity>
          {statusText ? (
            <Text style={[styles.hint, puncStyles.hintAfterAction]}>
              {statusText}
            </Text>
          ) : null}
        </View>

        {error ? (
          <View style={styles.section}>
            <Text style={puncStyles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.resultSection}>
          <Text style={styles.resultLabel}>Punctuated live output</Text>
          <Text style={puncStyles.outputReadonly}>{outputText}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
