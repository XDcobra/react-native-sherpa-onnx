import { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  DocumentDirectoryPath,
  exists,
  readFile,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import type { RootStackParamList } from '../types/navigation';

type ScreenId = keyof RootStackParamList;

type ScreenIntroCopy = {
  title: string;
  body: string;
};

const INTRO_COPY: Record<ScreenId, ScreenIntroCopy> = {
  Home: {
    title: 'Example app overview',
    body: 'This screen is the navigation hub for the example app. It helps you jump into each SDK area and see how the modules fit together at a glance.',
  },
  STT: {
    title: 'Speech-to-Text demo',
    body: 'This screen focuses on offline and streaming STT. Watch how model selection, buffer-driven input, and live transcription behave under real pipeline conditions.',
  },
  STTStreaming: {
    title: 'Speech-to-Text streaming demo',
    body: 'This screen streams long audio through LiveAudioBuffer and LiveTextBuffer so transcription can start immediately without building a large offline decode buffer. Use it for long files that can trigger offline OOM when full decode buffers are too large.',
  },
  TTS: {
    title: 'Text-to-Speech (offline)',
    body: 'This screen runs batch TTS: one-shot or segmented offline synthesis, buffer-to-buffer output, save/share, and voice-cloning options where the model supports them. Incremental streaming synthesis lives on the Text-to-Speech (Streaming) screen.',
  },
  TTSStreaming: {
    title: 'Text-to-Speech streaming demo',
    body: 'This screen uses incremental TTS with live text and audio buffers so playback can start before the full prompt is finished. Configure text segmentation (off/manual/auto) here. For chunked offline synthesis, use Text-to-Speech (Offline).',
  },
  Punctuation: {
    title: 'Offline punctuation',
    body: 'This screen loads an offline CT-Transformer model, builds plain text into offline text buffers, runs the punctuation engine buffer-to-buffer, and shows a read-only punctuated result with a copy action. Re-run releases previous buffers; options mirror the library’s init and pass-through language field.',
  },
  PunctuationStreaming: {
    title: 'Streaming punctuation',
    body: 'This screen runs online CNN-BiLSTM punctuation over live text buffers. It is useful for checking the LiveTextBuffer input/output contract, pipeline lifecycle, and optional segmentation attach.',
  },
  OfflinePipelineShowcase: {
    title: 'Offline batch pipeline',
    body: 'This screen runs a full offline batch pipeline: audio file → STT (with optional speech segmentation) → transcript → TTS (with optional text segmentation) → synthesized audio → playback. Enable segmentation on either stage to process large inputs in chunks and keep peak native RAM low.',
  },
  LivePipelineShowcase: {
    title: 'Live streaming pipeline',
    body: 'This screen runs the full end-to-end streaming pipeline concurrently: mic or file audio → StreamingSTT → committed text segments → StreamingTTS → live audio → real-time playback. The segment event log shows each STT commit and its forwarding to TTS. Optional text re-segmentation between STT and TTS aligns input at sentence boundaries.',
  },
  FileIO: {
    title: 'File I/O sandbox',
    body: 'Codec and FileDestination sandbox: probe/decode/encode bundled test_codec assets or a picked file, then export via saveAudioAsFile to fs, app, contentUri, and other destination kinds.',
  },
  AudioVisualization: {
    title: 'Audio visualization API',
    body: 'The public SDK (`react-native-sherpa-onnx/visualization`) computes spectrum data in native code and returns `levels` plus optional timeline `frames` — it does not ship any UI widgets. Your app is responsible for drawing bars, heatmaps, scrubbers, or 3D views from that data. This screen demonstrates the API: pick audio, call `computeAudioVisualizationProfile`, then render the result yourself. The Static, Animated, Heatmap, and Skia-based 3D tabs here are example UI only, built for this demo app.',
  },
  GenerateTimestamp: {
    title: 'Alignment and subtitle generation',
    body: 'This screen demonstrates how audio and text are aligned into timestamps. It is useful for understanding the subtitle and alignment APIs before exporting results.',
  },
  DownloadShowcase: {
    title: 'Model download workflow',
    body: 'This screen is a practical view of model acquisition. It helps you inspect how downloads, extraction, pause and resume states are handled for different model categories.',
  },
  VAD: {
    title: 'Voice activity detection showcase',
    body: 'This screen demonstrates standalone VAD with a pipeline-first flow: live or offline audio in, segment buffers out, speech-state callbacks, runtime metrics, and event timelines for debugging.',
  },
  SegmentationShowcase: {
    title: 'Segmentation playground',
    body: 'This screen is an integrator playground for text and audio segmentation. Use configurable policies to set segment boundaries (text: sentence, length limits; audio: silence, energy thresholds). Try both modes to understand segmentation trade-offs on real inputs.',
  },
  Diarization: {
    title: 'Speaker diarization demo',
    body: 'Offline batch diarization: load a pyannote/reverb segmentation model plus a speaker-embedding model, pick audio, and get anonymous speaker clusters with timestamps. Re-cluster and match centroids to enrolled SID names when you need real labels.',
  },
  Enhancement: {
    title: 'Speech enhancement demo',
    body: 'This screen demonstrates offline enhancement on noisy audio. It helps you see how the SDK improves the signal before downstream recognition or playback steps.',
  },
  EnhancementStreaming: {
    title: 'Streaming enhancement demo',
    body: 'This screen mirrors the offline enhancement flow but runs through live input/output buffers and a streaming pipeline. Use it for long files that can trigger offline OOM when full decode buffers are too large.',
  },
  Separation: {
    title: 'Source separation demo',
    body: 'Split mixed audio into stems (typically vocals and accompaniment) using Spleeter or UVR models. Try offline batch with optional segmentation, or live overload with file ingest or microphone input. Download models from the Download screen if needed.',
  },
  SpeakerIdentification: {
    title: 'Speaker identification demo',
    body: 'Enroll named speakers from offline audio, then identify, verify, or label speech segments. Switch to live overload to label a mic or file stream with the same embedding model (mandatory speech segmentation). Export/import enrollment JSON for cross-session restore.',
  },
  Settings: {
    title: 'Runtime capability dashboard',
    body: 'This screen is for checking execution-provider support and other runtime capabilities. It helps you verify what the current build and device can actually use.',
  },
};

const STORAGE_FILE = `${DocumentDirectoryPath}/example-screen-intros.json`;

type IntroState = Partial<Record<ScreenId, true>>;

let cachedState: IntroState | null = null;
let loadPromise: Promise<IntroState> | null = null;

async function loadState(): Promise<IntroState> {
  if (cachedState) {
    return cachedState;
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        if (!(await exists(STORAGE_FILE))) {
          return {};
        }
        const raw = await readFile(STORAGE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as IntroState;
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    })();
  }

  cachedState = await loadPromise;
  loadPromise = null;
  return cachedState;
}

async function setDismissed(screenId: ScreenId): Promise<void> {
  const current = await loadState();
  if (current[screenId]) {
    return;
  }
  const next: IntroState = { ...current, [screenId]: true };
  cachedState = next;
  await writeFile(STORAGE_FILE, JSON.stringify(next), 'utf8');
}

export function resetScreenIntroCache(): void {
  cachedState = null;
  loadPromise = null;
}

type Props = {
  screenId: ScreenId;
  containerStyle?: ViewStyle;
};

export function ScreenIntroModal({ screenId, containerStyle }: Props) {
  const copy = INTRO_COPY[screenId];
  const [visible, setVisible] = useState(false);
  const [dismissAgain, setDismissAgain] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      setVisible(false);
      setDismissAgain(true);

      (async () => {
        const dismissed = await loadState();
        if (!isActive) {
          return;
        }
        if (!dismissed[screenId]) {
          setDismissAgain(true);
          setVisible(true);
        }
      })().catch(() => {});

      return () => {
        isActive = false;
        setVisible(false);
      };
    }, [screenId])
  );

  const handleOk = useCallback(async () => {
    if (dismissAgain) {
      await setDismissed(screenId);
    }
    setVisible(false);
  }, [dismissAgain, screenId]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleOk}
    >
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropPressable} onPress={() => {}} />
        <View style={[styles.card, containerStyle]}>
          <View style={styles.header}>
            <View style={styles.iconWrap}>
              <Ionicons
                name="information-circle-outline"
                size={24}
                color="#007AFF"
              />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>{copy.title}</Text>
              <Text style={styles.subtitle}>Developer guidance</Text>
            </View>
          </View>

          <Text style={styles.body}>{copy.body}</Text>

          <Pressable
            style={styles.checkboxRow}
            onPress={() => setDismissAgain((value) => !value)}
          >
            <View style={styles.checkboxBox}>
              {dismissAgain ? (
                <Ionicons name="checkmark" size={16} color="#FFFFFF" />
              ) : null}
            </View>
            <Text style={styles.checkboxLabel}>
              Don't show this message again
            </Text>
          </Pressable>

          <Pressable
            style={styles.button}
            onPress={() => {
              handleOk().catch(() => {});
            }}
          >
            <Text style={styles.buttonText}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.58)',
    justifyContent: 'center',
    padding: 20,
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#EAF2FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 2,
  },
  body: {
    fontSize: 15,
    lineHeight: 23,
    color: '#374151',
    marginBottom: 18,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    marginBottom: 16,
  },
  checkboxBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#007AFF',
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: '#111827',
    fontWeight: '500',
  },
  button: {
    alignSelf: 'flex-end',
    minWidth: 88,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
