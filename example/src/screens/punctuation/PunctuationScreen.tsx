import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type { OfflineTextBufferRef } from 'react-native-sherpa-onnx/textbuffer';
import { OfflineTextBufferResultCard } from '../../components/OfflineTextBufferResultCard';
import { PunctuationModelInitPanel } from '../../components/PunctuationModelInitPanel';
import {
  formatPunctuationInitError,
  usePunctuationModelInit,
} from '../../hooks/usePunctuationModelInit';
import {
  readOfflineTextBufferSnapshot,
  type OfflineTextBufferSnapshot,
} from '../../utils/readOfflineTextBufferSnapshot';
import { styles } from '../stt/STTScreen.styles';
import { puncStyles } from './PunctuationScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const DEFAULT_INPUT =
  'this is a sample line without capitals or commas it shows offline ct punctuation on device';

export default function PunctuationScreen() {
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );
  const punctuation = usePunctuationModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const [punctuateBusy, setPunctuateBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [inputText, setInputText] = useState(DEFAULT_INPUT);
  const [outputSnapshot, setOutputSnapshot] =
    useState<OfflineTextBufferSnapshot | null>(null);
  const [langPassThrough, setLangPassThrough] = useState('en');
  const [lastProcessingMs, setLastProcessingMs] = useState<number | null>(null);
  const [lastSegmentStatus, setLastSegmentStatus] = useState<string | null>(
    null
  );
  const [offlineSegConfig, setOfflineSegConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });

  const textInRef = useRef<OfflineTextBufferRef | null>(null);
  const textOutRef = useRef<OfflineTextBufferRef | null>(null);

  const { engineRef, loading, isEngineInitialized } = punctuation;

  const releaseTextBuffers = useCallback(async () => {
    if (textInRef.current) {
      await releasePipelineTextBuffer(textInRef.current).catch(() => {});
      textInRef.current = null;
    }
    if (textOutRef.current) {
      await releasePipelineTextBuffer(textOutRef.current).catch(() => {});
      textOutRef.current = null;
    }
  }, []);

  onBeforeInitRef.current = async () => {
    setOutputSnapshot(null);
    setLastProcessingMs(null);
    setLastSegmentStatus(null);
    setRunError(null);
    await releaseTextBuffers();
  };

  useEffect(() => {
    return () => {
      releaseTextBuffers().catch(() => {});
    };
  }, [releaseTextBuffers]);

  const handleFree = async () => {
    await punctuation.releaseEngine();
    await releaseTextBuffers();
    setOutputSnapshot(null);
    setLastProcessingMs(null);
    setLastSegmentStatus(null);
    setRunError(null);
  };

  const handlePunctuate = async () => {
    const engine = engineRef.current;
    if (!engine) {
      Alert.alert('Engine', 'Load a model first (Initialize).');
      return;
    }
    const plain = inputText.trim();
    if (!plain) {
      Alert.alert('Text', 'Enter some plain text to punctuate.');
      return;
    }
    setPunctuateBusy(true);
    setRunError(null);
    setLastProcessingMs(null);
    setLastSegmentStatus(null);
    try {
      await releaseTextBuffers();
      setOutputSnapshot(null);

      const lang = langPassThrough.trim();
      const textIn = await createOfflineTextBufferFromText(plain, {
        lang: lang.length > 0 ? lang : undefined,
      });
      const textOut = await createEmptyOfflineTextBuffer();
      textInRef.current = textIn;
      textOutRef.current = textOut;

      const result = await engine.punctuate(textIn, textOut, {
        segmentation: buildSegmentationOption(offlineSegConfig),
        errorRecovery: 'retry',
        maxRetriesPerSegment: 1,
        retryExhaustedFallback: 'skip',
        overlapChars: offlineSegConfig.mode !== 'off' ? 24 : 0,
        textSkipPlaceholder: '',
      });
      const { processingTimeMs } = result;
      setLastProcessingMs(processingTimeMs);
      if (result.status) {
        setLastSegmentStatus(
          `${result.status}: ${result.completedSegments ?? 0}/${
            result.totalSegments ?? 0
          } segments`
        );
      }
      const snapshot = await readOfflineTextBufferSnapshot(
        typeof textOut === 'string' ? textOut : textOut.bufferId
      );
      setOutputSnapshot(snapshot);
    } catch (e) {
      setRunError(formatPunctuationInitError(e));
    } finally {
      setPunctuateBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Offline CT punctuation</Text>
          <Text style={styles.hint}>
            Model directory must be an offline CT-Transformer layout. Flow:
            create offline text from your input, empty buffer for output, run
            punctuate, then read the output buffer. Re-running releases previous
            buffers and allocates new ones.
          </Text>
        </View>

        {isEngineInitialized ? (
          <TouchableOpacity
            style={styles.freeButton}
            onPress={handleFree}
            disabled={loading || punctuateBusy}
          >
            <Text style={styles.freeButtonText}>Release model</Text>
          </TouchableOpacity>
        ) : null}

        <PunctuationModelInitPanel
          punctuation={punctuation}
          disabled={punctuateBusy}
        />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3. Text (input buffer)</Text>
          <Text style={puncStyles.smallLabel}>
            Optional BCP-47 language for pass-through to the output buffer (not
            inferred by the model)
          </Text>
          <TextInput
            style={puncStyles.optionInput}
            value={langPassThrough}
            onChangeText={setLangPassThrough}
            autoCapitalize="none"
            placeholder="e.g. en"
            editable={!punctuateBusy}
          />
          <Text style={puncStyles.smallLabel}>plain text to punctuate</Text>
          <TextInput
            style={[puncStyles.optionInput, puncStyles.multilineInput]}
            multiline
            value={inputText}
            onChangeText={setInputText}
            placeholder="Unpunctuated text…"
            editable={!punctuateBusy}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>4. Run (buffer → buffer)</Text>
          <SegmentationPolicyControls
            variant="text-offline"
            value={offlineSegConfig}
            onChange={setOfflineSegConfig}
            disabled={punctuateBusy || !isEngineInitialized}
          />
          <TouchableOpacity
            style={[
              styles.button,
              (punctuateBusy || !isEngineInitialized) && styles.buttonDisabled,
            ]}
            disabled={punctuateBusy || !isEngineInitialized}
            onPress={handlePunctuate}
          >
            {punctuateBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Punctuate (offline)</Text>
            )}
          </TouchableOpacity>
          {lastProcessingMs != null ? (
            <Text style={[styles.hint, puncStyles.hintAfterAction]}>
              Native addPunctuation: {lastProcessingMs.toFixed(1)} ms
            </Text>
          ) : null}
          {lastSegmentStatus ? (
            <Text style={[styles.hint, puncStyles.hintAfterAction]}>
              Segmented orchestration: {lastSegmentStatus}
            </Text>
          ) : null}
        </View>

        {runError ? (
          <View style={styles.section}>
            <Text style={puncStyles.errorText}>{runError}</Text>
          </View>
        ) : null}

        {outputSnapshot ? (
          <OfflineTextBufferResultCard
            title="Punctuated output"
            textLabel="Punctuated text:"
            result={outputSnapshot}
            showExpanders={false}
            showMeta={false}
            showJsonExport={false}
            showBufferList={false}
          />
        ) : null}
      </ScrollView>
      <ScreenIntroModal screenId="Punctuation" />
    </SafeAreaView>
  );
}
