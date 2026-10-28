import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import {
  createEmptyOfflineAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferSpatialSpansSlice,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
  type OfflineTextBufferRef,
  type TextSpatialSpan,
} from 'react-native-sherpa-onnx/textbuffer';
import { extractDocumentText } from 'react-native-sherpa-onnx/document';
import {
  extractPdfTextLayer,
  isPdfiumEnabled,
  PdfErrorCode,
} from 'react-native-sherpa-onnx/pdf';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { TtsModelInitPanel } from '../../components/TtsModelInitPanel';
import { ExampleDocumentFileList } from '../../components/ExampleDocumentFileList';
import { useTtsModelInit } from '../../hooks/useTtsModelInit';
import {
  DOCUMENT_FILES,
  type DocumentExtractKind,
  type DocumentFileInfo,
} from '../../documentConfig';
import { materializeBundledDocumentSource } from '../../utils/documentSource';
import {
  fileSourceFromBundledPath,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { styles } from './DocumentsScreen.styles';

type ExtractStatus = 'idle' | 'ok' | 'noTextLayer' | 'error';

function nativeErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return '';
}

function extensionOf(path: string): string {
  const base = path.split('?')[0] ?? path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function extractKindFromPath(path: string): DocumentExtractKind {
  return extensionOf(path) === 'pdf' ? 'pdf' : 'document';
}

export default function DocumentsScreen() {
  const tts = useTtsModelInit();
  const setTtsError = tts.setError;
  const [sourceType, setSourceType] = useState<'example' | 'own' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [extractStatus, setExtractStatus] = useState<ExtractStatus>('idle');
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  const [resultText, setResultText] = useState('');
  const [spans, setSpans] = useState<TextSpatialSpan[]>([]);
  const [extractBusy, setExtractBusy] = useState(false);
  const [speakBusy, setSpeakBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);

  const textBufRef = useRef<OfflineTextBufferRef | null>(null);
  const audioBufIdRef = useRef<string | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationMsRef = useRef(0);

  const stopPlayback = useCallback(async () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      await player.destroy().catch(() => {});
    }
    setPlaying(false);
    setHighlightIndex(null);
  }, []);

  const releaseTextBuf = useCallback(async () => {
    const buf = textBufRef.current;
    textBufRef.current = null;
    if (buf) {
      await releasePipelineTextBuffer(buf.bufferId).catch(() => {});
    }
  }, []);

  const releaseAudioBuf = useCallback(async () => {
    const id = audioBufIdRef.current;
    audioBufIdRef.current = null;
    if (id) {
      await releasePipelineAudioBuffer(id).catch(() => {});
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
      playerRef.current?.destroy().catch(() => {});
      const textId = textBufRef.current?.bufferId;
      const audioId = audioBufIdRef.current;
      textBufRef.current = null;
      audioBufIdRef.current = null;
      if (textId) {
        releasePipelineTextBuffer(textId).catch(() => {});
      }
      if (audioId) {
        releasePipelineAudioBuffer(audioId).catch(() => {});
      }
    };
  }, []);

  const loadExtractedText = useCallback(
    async (textOut: OfflineTextBufferRef) => {
      const info = (await getPipelineTextBufferInfo(
        textOut
      )) as OfflineTextBufferInfo;
      const text =
        info.utf16Length > 0
          ? await getOfflineTextBufferTextSlice(textOut, 0, info.utf16Length)
          : '';
      const spatial =
        info.hasSpatialSpans && info.spatialSpanCount > 0
          ? await getOfflineTextBufferSpatialSpansSlice(
              textOut,
              0,
              info.spatialSpanCount
            )
          : [];
      setResultText(text);
      setSpans(spatial);
    },
    []
  );

  const runExtract = useCallback(
    async (
      source: FileSource,
      kind: DocumentExtractKind,
      label: string,
      fixtureId: string | null
    ) => {
      setExtractBusy(true);
      setExtractStatus('idle');
      setExtractMessage(null);
      setResultText('');
      setSpans([]);
      setHighlightIndex(null);
      setTtsError(null);
      await stopPlayback();
      await releaseAudioBuf();
      await releaseTextBuf();
      setSourceLabel(label);
      setSelectedId(fixtureId);

      try {
        const textOut = await createEmptyOfflineTextBuffer();
        textBufRef.current = textOut;
        if (kind === 'pdf') {
          const enabled = await isPdfiumEnabled();
          if (!enabled) {
            throw new Error(
              `${PdfErrorCode.PDFIUM_DISABLED}: rebuild with sherpaOnnxEnablePdfium=true / SHERPA_ONNX_ENABLE_PDFIUM=1`
            );
          }
          const result = await extractPdfTextLayer(source, textOut);
          await loadExtractedText(textOut);
          setExtractStatus('ok');
          setExtractMessage(
            `ok pages=${result.pageCount} withText=${result.pagesWithText} spans=${result.spatialSpanCount}`
          );
          return;
        }
        const result = await extractDocumentText(source, textOut);
        await loadExtractedText(textOut);
        setExtractStatus('ok');
        setExtractMessage(
          `ok format=${result.format} sections=${result.sectionCount} spans=${result.spatialSpanCount}`
        );
      } catch (err) {
        await releaseTextBuf();
        const msg = err instanceof Error ? err.message : String(err);
        const code = nativeErrorCode(err);
        const noTextLayer =
          code === PdfErrorCode.NO_TEXT_LAYER ||
          msg.includes(PdfErrorCode.NO_TEXT_LAYER);
        if (noTextLayer) {
          setExtractStatus('noTextLayer');
          setExtractMessage(PdfErrorCode.NO_TEXT_LAYER);
          return;
        }
        setExtractStatus('error');
        setExtractMessage(msg);
        setTtsError(msg);
      } finally {
        setExtractBusy(false);
      }
    },
    [
      loadExtractedText,
      releaseAudioBuf,
      releaseTextBuf,
      setTtsError,
      stopPlayback,
    ]
  );

  const handleExamplePick = useCallback(
    async (file: DocumentFileInfo) => {
      const source =
        file.extract === 'document'
          ? await materializeBundledDocumentSource(file.id)
          : fileSourceFromBundledPath(file.id);
      await runExtract(source, file.extract, file.name, file.id);
    },
    [runExtract]
  );

  const handleChooseFile = useCallback(async () => {
    try {
      const picked = await DocumentPicker.pick({
        type: [
          DocumentPicker.types.pdf,
          'application/epub+zip',
          'application/x-fictionbook+xml',
          'application/xml',
        ],
        allowMultiSelection: false,
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? '';
      const name = file?.name?.trim() || uri.split('/').pop() || 'document';
      if (!uri) {
        setTtsError('Could not get file URI from picker');
        return;
      }
      const source = toFileSource(uri, name);
      await runExtract(source, extractKindFromPath(name), name, null);
    } catch (err: unknown) {
      if (
        (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
          err
        )
      ) {
        return;
      }
      setTtsError(err instanceof Error ? err.message : String(err));
    }
  }, [runExtract, setTtsError]);

  const startHighlightPoll = useCallback(
    (durationMs: number) => {
      durationMsRef.current = durationMs;
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
      pollRef.current = setInterval(() => {
        const player = playerRef.current;
        if (!player || durationMsRef.current <= 0) {
          return;
        }
        player
          .getPlaybackPositionMs()
          .then((positionMs) => {
            const text = resultText;
            if (!text) {
              return;
            }
            const fraction = Math.min(
              1,
              Math.max(0, positionMs / durationMsRef.current)
            );
            const cursor = Math.floor(fraction * text.length);
            if (spans.length === 0) {
              setHighlightIndex(0);
              return;
            }
            let idx = spans.findIndex(
              (span) => cursor >= span.utf16Start && cursor < span.utf16End
            );
            if (idx < 0) {
              idx = spans.findIndex((span) => cursor < span.utf16End);
            }
            setHighlightIndex(idx >= 0 ? idx : spans.length - 1);
          })
          .catch(() => {});
      }, 250);
    },
    [resultText, spans]
  );

  const handleSpeak = useCallback(async () => {
    const engine = tts.engineRef.current;
    if (!engine || !tts.selectedModelType) {
      setTtsError('Initialize a TTS model first.');
      return;
    }
    const textBuf = textBufRef.current;
    if (!textBuf || extractStatus !== 'ok' || !resultText) {
      setTtsError('Extract readable text first.');
      return;
    }
    setSpeakBusy(true);
    setTtsError(null);
    await stopPlayback();
    await releaseAudioBuf();
    try {
      const sid = parseInt(tts.speakerId, 10);
      const speed = parseFloat(tts.speed);
      const audioBuf = await createEmptyOfflineAudioBuffer(
        tts.modelInfo?.sampleRate ?? 16000
      );
      audioBufIdRef.current = audioBuf.bufferId;
      await engine.synthesize(textBuf, audioBuf, {
        sid: Number.isFinite(sid) ? sid : 0,
        speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
      });
      const info = await getPipelineAudioBufferInfo(audioBuf.bufferId);
      const durationMs =
        info.sampleRate > 0
          ? ((info.numSamples ?? 0) / info.sampleRate) * 1000
          : 0;
      const player = await createPcmPlayer(audioBuf.bufferId, {
        onEnded: () => {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setPlaying(false);
          setHighlightIndex(spans.length > 0 ? spans.length - 1 : 0);
        },
      });
      playerRef.current = player;
      setPlaying(true);
      startHighlightPoll(durationMs);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpeakBusy(false);
    }
  }, [
    extractStatus,
    releaseAudioBuf,
    resultText,
    setTtsError,
    spans.length,
    startHighlightPoll,
    stopPlayback,
    tts.engineRef,
    tts.modelInfo?.sampleRate,
    tts.selectedModelType,
    tts.speakerId,
    tts.speed,
  ]);

  const renderHighlightedText = () => {
    if (!resultText) {
      return (
        <Text style={styles.placeholder}>
          Pick a document to extract readable text.
        </Text>
      );
    }
    if (spans.length === 0) {
      return (
        <Text
          style={[styles.bodyText, highlightIndex === 0 && styles.highlight]}
        >
          {resultText}
        </Text>
      );
    }
    const nodes: ReactNode[] = [];
    let cursor = 0;
    spans.forEach((span, index) => {
      if (span.utf16Start > cursor) {
        nodes.push(
          <Text key={`gap-${cursor}`}>
            {resultText.slice(cursor, span.utf16Start)}
          </Text>
        );
      } else if (index > 0) {
        nodes.push(<Text key={`sep-${span.utf16Start}`}>{'\n'}</Text>);
      }
      nodes.push(
        <Text
          key={`${span.utf16Start}-${span.utf16End}-${index}`}
          style={highlightIndex === index ? styles.highlight : undefined}
        >
          {resultText.slice(span.utf16Start, span.utf16End)}
        </Text>
      );
      cursor = span.utf16End;
    });
    if (cursor < resultText.length) {
      nodes.push(
        <Text key={`gap-end-${cursor}`}>{resultText.slice(cursor)}</Text>
      );
    }
    return <Text style={styles.bodyText}>{nodes}</Text>;
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenIntroModal screenId="Documents" />
        <View style={styles.header}>
          <Ionicons name="book-outline" size={48} style={styles.icon} />
          <Text style={styles.title}>Read aloud</Text>
          <Text style={styles.subtitle}>
            Extract EPUB / FB2 markup or a PDF text layer, then speak it with
            offline TTS. Scan-only PDFs belong on the OCR screen.
          </Text>
        </View>

        {tts.isEngineInitialized ? (
          <TouchableOpacity
            style={styles.releaseButton}
            onPress={() => {
              tts.releaseEngine().catch(() => {});
            }}
            disabled={tts.loading}
          >
            <Text style={styles.releaseButtonText}>Release TTS model</Text>
          </TouchableOpacity>
        ) : null}

        <TtsModelInitPanel tts={tts} showScatteredTest={false} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pick a document</Text>
          <Text style={styles.sectionHint}>
            Bundled text EPUBs/FB2 and digital PDFs extract text. Scan-only PDFs
            reject with no text layer.
          </Text>
          {sourceType == null ? (
            <View style={styles.sourceChoiceRow}>
              <TouchableOpacity
                style={[
                  styles.sourceChoiceButton,
                  extractBusy && styles.sourceChoiceButtonDisabled,
                ]}
                onPress={() => setSourceType('example')}
                disabled={extractBusy}
              >
                <Text style={styles.sourceChoiceButtonText}>Example files</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.sourceChoiceButton,
                  extractBusy && styles.sourceChoiceButtonDisabled,
                ]}
                onPress={() => {
                  setSourceType('own');
                  handleChooseFile().catch(() => {});
                }}
                disabled={extractBusy}
              >
                <Text style={styles.sourceChoiceButtonText}>Pick your own</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {sourceType === 'example' ? (
            <>
              <View style={styles.sourceActionRow}>
                <TouchableOpacity
                  style={[
                    styles.backButton,
                    extractBusy && styles.buttonDisabled,
                  ]}
                  onPress={() => setSourceType(null)}
                  disabled={extractBusy}
                  accessibilityLabel="Back"
                >
                  <Ionicons name="chevron-back" size={22} color="#007AFF" />
                </TouchableOpacity>
                <Text
                  style={[styles.subsectionTitle, styles.sourceActionTitle]}
                >
                  Choose an example document
                </Text>
              </View>
              <ExampleDocumentFileList
                files={DOCUMENT_FILES}
                selectedId={selectedId}
                onSelect={(file) => {
                  handleExamplePick(file).catch(() => {});
                }}
                disabled={extractBusy}
              />
            </>
          ) : null}
          {sourceType === 'own' ? (
            <View style={styles.sourceActionRow}>
              <TouchableOpacity
                style={[
                  styles.backButton,
                  extractBusy && styles.buttonDisabled,
                ]}
                onPress={() => setSourceType(null)}
                disabled={extractBusy}
                accessibilityLabel="Back"
              >
                <Ionicons name="chevron-back" size={22} color="#007AFF" />
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.sourceChoiceButton,
                  extractBusy && styles.sourceChoiceButtonDisabled,
                ]}
                onPress={() => {
                  handleChooseFile().catch(() => {});
                }}
                disabled={extractBusy}
              >
                <Text style={styles.sourceChoiceButtonText}>
                  Pick EPUB, FB2, or PDF…
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {extractStatus === 'noTextLayer' ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionTitle}>No text layer</Text>
            <Text style={styles.sectionHint}>
              This PDF has no extractable text layer ({extractMessage}). Only
              OCR can continue — open Vision → OCR, pick the same scan PDF, and
              run recognize.
            </Text>
          </View>
        ) : null}

        {extractStatus === 'error' && extractMessage ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionTitle}>Extract failed</Text>
            <Text style={styles.sectionHint}>{extractMessage}</Text>
          </View>
        ) : null}

        {tts.error ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionHint}>{tts.error}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Extracted text</Text>
          {sourceLabel ? (
            <Text style={styles.meta}>
              {sourceLabel}
              {extractMessage && extractStatus === 'ok'
                ? ` · ${extractMessage}`
                : ''}
            </Text>
          ) : null}
          {extractBusy ? (
            <ActivityIndicator color="#007AFF" />
          ) : (
            renderHighlightedText()
          )}
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (speakBusy ||
                extractBusy ||
                extractStatus !== 'ok' ||
                !tts.selectedModelType) &&
                styles.buttonDisabled,
            ]}
            onPress={() => {
              handleSpeak().catch(() => {});
            }}
            disabled={
              speakBusy ||
              extractBusy ||
              extractStatus !== 'ok' ||
              !tts.selectedModelType
            }
          >
            {speakBusy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {playing ? 'Speaking…' : 'Speak'}
              </Text>
            )}
          </TouchableOpacity>
          {playing ? (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                stopPlayback().catch(() => {});
              }}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
