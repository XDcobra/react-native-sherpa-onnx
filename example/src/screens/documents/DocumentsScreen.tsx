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
  extractDocumentImages,
  extractDocumentText,
  DocumentErrorCode,
} from 'react-native-sherpa-onnx/document';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferSpatialSpansSlice,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
  type OfflineTextBufferRef,
  type TextSpatialSpan,
} from 'react-native-sherpa-onnx/textbuffer';
import { releaseOfflineImageBuffer } from 'react-native-sherpa-onnx/imagebuffer';
import type { OcrProgress } from 'react-native-sherpa-onnx/ocr';
import {
  extractPdfTextLayer,
  isPdfiumEnabled,
  PdfErrorCode,
} from 'react-native-sherpa-onnx/pdf';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { OfflineImageBufferFramePager } from '../../components/OfflineImageBufferFramePager';
import { OcrModelInitPanel } from '../../components/OcrModelInitPanel';
import {
  OcrRecognizeProgressBox,
  type OcrProgressBoxHandle,
} from '../../components/OcrRecognizeProgressBox';
import { ExampleDocumentFileList } from '../../components/ExampleDocumentFileList';
import { FileSourcePicker } from '../../components/FileSourcePicker';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { TtsModelInitPanel } from '../../components/TtsModelInitPanel';
import { useOcrModelInit } from '../../hooks/useOcrModelInit';
import { useTtsModelInit } from '../../hooks/useTtsModelInit';
import {
  DOCUMENT_FILES,
  type DocumentExtractKind,
  type DocumentFileInfo,
} from '../../documentConfig';
import {
  fileSourceFromBundledPath,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { styles } from './DocumentsScreen.styles';

type ExtractStatus =
  | 'idle'
  | 'ok'
  | 'noTextLayer'
  | 'imagesOnly'
  | 'drm'
  | 'error';
type OriginKind = 'markup' | 'ocr' | 'textLayer';

type ReadingBlock = {
  origin: OriginKind;
  text: string;
  sectionIndex: number;
  frameIndex: number;
  utf16Start: number;
  utf16End: number;
};

type ReadingDraft = Omit<ReadingBlock, 'utf16Start' | 'utf16End'>;

type ImageInfo = {
  bufferId: string;
  frameCount: number;
};

type DocProgress = {
  phase: string;
  done: number;
  total: number;
};

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

function docDebug(payload: Record<string, unknown>): void {
  if (__DEV__) {
    console.log('[Documents]', payload);
  }
}

function spanOrigin(span: TextSpatialSpan, fallback: OriginKind): OriginKind {
  if (
    span.origin === 'markup' ||
    span.origin === 'ocr' ||
    span.origin === 'textLayer'
  ) {
    return span.origin;
  }
  return fallback;
}

function blocksFromSpans(
  text: string,
  spans: TextSpatialSpan[],
  fallback: OriginKind
): ReadingDraft[] {
  if (!text) {
    return [];
  }
  if (spans.length === 0) {
    return [{ origin: fallback, text, sectionIndex: 0, frameIndex: 0 }];
  }
  const drafts: ReadingDraft[] = [];
  let current: ReadingDraft | null = null;
  for (const span of spans) {
    const origin = spanOrigin(span, fallback);
    const sectionIndex = span.sectionIndex ?? 0;
    const frameIndex = span.frameIndex ?? 0;
    const slice = text.slice(span.utf16Start, span.utf16End);
    if (!slice) {
      continue;
    }
    if (
      current &&
      current.origin === origin &&
      current.sectionIndex === sectionIndex &&
      current.frameIndex === frameIndex
    ) {
      current.text = `${current.text}\n${slice}`;
    } else {
      current = { origin, text: slice, sectionIndex, frameIndex };
      drafts.push(current);
    }
  }
  return drafts.length > 0
    ? drafts
    : [{ origin: fallback, text, sectionIndex: 0, frameIndex: 0 }];
}

function assignReadingOrder(drafts: ReadingDraft[]): {
  blocks: ReadingBlock[];
  joined: string;
} {
  const sorted = [...drafts].sort((a, b) => {
    if (a.sectionIndex !== b.sectionIndex) {
      return a.sectionIndex - b.sectionIndex;
    }
    if (a.frameIndex !== b.frameIndex) {
      return a.frameIndex - b.frameIndex;
    }
    if (a.origin === b.origin) {
      return 0;
    }
    if (a.origin === 'markup') {
      return -1;
    }
    if (b.origin === 'markup') {
      return 1;
    }
    return 0;
  });
  const blocks: ReadingBlock[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const draft of sorted) {
    const utf16Start = cursor;
    const utf16End = utf16Start + draft.text.length;
    blocks.push({ ...draft, utf16Start, utf16End });
    parts.push(draft.text);
    cursor = utf16End + 1;
  }
  return { blocks, joined: parts.join('\n') };
}

export default function DocumentsScreen() {
  const tts = useTtsModelInit();
  const ocrAbortRef = useRef<AbortController | null>(null);
  const ocr = useOcrModelInit({
    onBeforeInit: () => {
      ocrAbortRef.current?.abort();
      ocrAbortRef.current = null;
    },
  });
  const setTtsError = tts.setError;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [extractStatus, setExtractStatus] = useState<ExtractStatus>('idle');
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  const [resultText, setResultText] = useState('');
  const [spans, setSpans] = useState<TextSpatialSpan[]>([]);
  const [extractBusy, setExtractBusy] = useState(false);
  const [imageStepUnlocked, setImageStepUnlocked] = useState(false);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [imageExtractBusy, setImageExtractBusy] = useState(false);
  const [imageProgress, setImageProgress] = useState<DocProgress | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrRunError, setOcrRunError] = useState<string | null>(null);
  const [ocrTextBufferId, setOcrTextBufferId] = useState<string | null>(null);
  const [readingBlocks, setReadingBlocks] = useState<ReadingBlock[]>([]);
  const [joinedText, setJoinedText] = useState('');
  const [speakBusy, setSpeakBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);

  const textBufRef = useRef<OfflineTextBufferRef | null>(null);
  const ocrTextBufRef = useRef<OfflineTextBufferRef | null>(null);
  const speakTextBufRef = useRef<OfflineTextBufferRef | null>(null);
  const imageBufIdRef = useRef<string | null>(null);
  const audioBufIdRef = useRef<string | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationMsRef = useRef(0);
  const ocrProgressBoxRef = useRef<OcrProgressBoxHandle>(null);

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

  const releaseOcrTextBuf = useCallback(async () => {
    const buf = ocrTextBufRef.current;
    ocrTextBufRef.current = null;
    setOcrTextBufferId(null);
    if (buf) {
      await releasePipelineTextBuffer(buf.bufferId).catch(() => {});
    }
  }, []);

  const releaseSpeakTextBuf = useCallback(async () => {
    const buf = speakTextBufRef.current;
    speakTextBufRef.current = null;
    if (buf) {
      await releasePipelineTextBuffer(buf.bufferId).catch(() => {});
    }
  }, []);

  const releaseImageBuf = useCallback(async () => {
    const id = imageBufIdRef.current;
    imageBufIdRef.current = null;
    setImageInfo(null);
    if (id) {
      await releaseOfflineImageBuffer(id).catch(() => {});
    }
  }, []);

  const releaseAudioBuf = useCallback(async () => {
    const id = audioBufIdRef.current;
    audioBufIdRef.current = null;
    if (id) {
      await releasePipelineAudioBuffer(id).catch(() => {});
    }
  }, []);

  const resetImageOcrState = useCallback(async () => {
    ocrAbortRef.current?.abort();
    ocrAbortRef.current = null;
    ocrProgressBoxRef.current?.reset();
    setImageStepUnlocked(false);
    setImageProgress(null);
    setOcrRunError(null);
    setReadingBlocks([]);
    setJoinedText('');
    await releaseOcrTextBuf();
    await releaseSpeakTextBuf();
    await releaseImageBuf();
  }, [releaseImageBuf, releaseOcrTextBuf, releaseSpeakTextBuf]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
      playerRef.current?.destroy().catch(() => {});
      ocrAbortRef.current?.abort();
      const textId = textBufRef.current?.bufferId;
      const ocrId = ocrTextBufRef.current?.bufferId;
      const speakId = speakTextBufRef.current?.bufferId;
      const imageId = imageBufIdRef.current;
      const audioId = audioBufIdRef.current;
      textBufRef.current = null;
      ocrTextBufRef.current = null;
      speakTextBufRef.current = null;
      imageBufIdRef.current = null;
      audioBufIdRef.current = null;
      if (textId) {
        releasePipelineTextBuffer(textId).catch(() => {});
      }
      if (ocrId) {
        releasePipelineTextBuffer(ocrId).catch(() => {});
      }
      if (speakId) {
        releasePipelineTextBuffer(speakId).catch(() => {});
      }
      if (imageId) {
        releaseOfflineImageBuffer(imageId).catch(() => {});
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
      return { text, spatial };
    },
    []
  );

  const applyReadingOrder = useCallback(
    (
      markupText: string,
      markupSpans: TextSpatialSpan[],
      recognizedText: string,
      recognizedSpans: TextSpatialSpan[],
      withOriginChips: boolean
    ) => {
      if (!withOriginChips) {
        setReadingBlocks([]);
        setJoinedText('');
        return;
      }
      const drafts = [
        ...blocksFromSpans(markupText, markupSpans, 'markup'),
        ...blocksFromSpans(recognizedText, recognizedSpans, 'ocr'),
      ];
      const { blocks, joined } = assignReadingOrder(drafts);
      docDebug({
        phase: 'interleave',
        markupBlocks: drafts.filter((d) => d.origin === 'markup').length,
        ocrBlocks: drafts.filter((d) => d.origin === 'ocr').length,
        joinedLength: joined.length,
        sectionIndexes: blocks.map((b) => b.sectionIndex),
      });
      setReadingBlocks(blocks);
      setJoinedText(joined);
    },
    []
  );

  const runExtractImages = useCallback(
    async (source: FileSource) => {
      setImageExtractBusy(true);
      setImageProgress(null);
      setOcrRunError(null);
      await releaseImageBuf();
      docDebug({
        phase: 'extractDocumentImages',
        kind: source.kind,
        branch: 'start',
      });
      try {
        const result = await extractDocumentImages(source, {
          maxSide: 1280,
          onProgress: (event) => {
            setImageProgress({
              phase: event.phase,
              done: event.done,
              total: event.total,
            });
          },
        });
        imageBufIdRef.current = result.buffer;
        setImageInfo({
          bufferId: result.buffer,
          frameCount: result.frameCount,
        });
        docDebug({
          phase: 'extractDocumentImages',
          branch: 'ok',
          format: result.format,
          frameCount: result.frameCount,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        docDebug({
          phase: 'extractDocumentImages',
          branch: 'error',
          error: msg,
        });
        setOcrRunError(msg);
        return null;
      } finally {
        setImageExtractBusy(false);
      }
    },
    [releaseImageBuf]
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
      await resetImageOcrState();
      setSourceLabel(label);
      setSelectedId(fixtureId);

      try {
        if (kind === 'pdf') {
          const enabled = await isPdfiumEnabled();
          if (!enabled) {
            throw new Error(
              `${PdfErrorCode.PDFIUM_DISABLED}: rebuild with sherpaOnnxEnablePdfium=true / SHERPA_ONNX_ENABLE_PDFIUM=1`
            );
          }
          const textOut = await createEmptyOfflineTextBuffer();
          textBufRef.current = textOut;
          const result = await extractPdfTextLayer(source, textOut);
          const loaded = await loadExtractedText(textOut);
          applyReadingOrder(loaded.text, loaded.spatial, '', [], false);
          setExtractStatus('ok');
          setExtractMessage(
            `ok pages=${result.pageCount} withText=${result.pagesWithText} spans=${result.spatialSpanCount}`
          );
          docDebug({
            phase: 'extract',
            kind: 'pdf',
            branch: 'textLayer',
            pages: result.pageCount,
          });
          return;
        }

        const textOut = await createEmptyOfflineTextBuffer();
        textBufRef.current = textOut;
        try {
          const result = await extractDocumentText(source, textOut);
          const loaded = await loadExtractedText(textOut);
          const mixed = result.imageOnlySections.length > 0;
          setExtractStatus('ok');
          setExtractMessage(
            `ok format=${result.format} sections=${result.sectionCount} imageOnly=${result.imageOnlySections.length} spans=${result.spatialSpanCount}`
          );
          docDebug({
            phase: 'extract',
            kind: 'document',
            branch: mixed ? 'mixed' : 'textOnly',
            format: result.format,
            sectionCount: result.sectionCount,
            imageOnly: result.imageOnlySections.length,
            sourceKind: source.kind,
          });
          if (mixed) {
            setImageStepUnlocked(true);
            applyReadingOrder(loaded.text, loaded.spatial, '', [], true);
            await runExtractImages(source);
          } else {
            applyReadingOrder(loaded.text, loaded.spatial, '', [], false);
          }
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = nativeErrorCode(err);
          const noMarkup =
            code === DocumentErrorCode.NO_TEXT ||
            msg.includes(DocumentErrorCode.NO_TEXT);
          if (!noMarkup) {
            throw err;
          }
          await releaseTextBuf();
          setResultText('');
          setSpans([]);
          setExtractStatus('imagesOnly');
          setExtractMessage(DocumentErrorCode.NO_TEXT);
          setImageStepUnlocked(true);
          applyReadingOrder('', [], '', [], true);
          docDebug({
            phase: 'extract',
            kind: 'document',
            branch: 'ERR_DOC_NO_TEXT',
            sourceKind: source.kind,
          });
          await runExtractImages(source);
        }
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
          docDebug({
            phase: 'extract',
            kind: 'pdf',
            branch: 'ERR_PDF_NO_TEXT_LAYER',
          });
          return;
        }
        const drm =
          code === DocumentErrorCode.DRM || msg.includes(DocumentErrorCode.DRM);
        if (drm) {
          setExtractStatus('drm');
          setExtractMessage(DocumentErrorCode.DRM);
          docDebug({
            phase: 'extract',
            kind: 'document',
            branch: 'ERR_DOC_DRM',
            sourceKind: source.kind,
          });
          return;
        }
        setExtractStatus('error');
        setExtractMessage(msg);
        setTtsError(msg);
        docDebug({
          phase: 'extract',
          branch: 'error',
          error: msg,
        });
      } finally {
        setExtractBusy(false);
      }
    },
    [
      applyReadingOrder,
      loadExtractedText,
      releaseAudioBuf,
      releaseTextBuf,
      resetImageOcrState,
      runExtractImages,
      setTtsError,
      stopPlayback,
    ]
  );

  const handleExamplePick = useCallback(
    async (file: DocumentFileInfo) => {
      const source = fileSourceFromBundledPath(file.id);
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
          'application/vnd.comicbook+zip',
          'application/x-cbz',
          'application/zip',
          'com.apple.comicbook-archive',
          'application/x-mobipocket-ebook',
          'application/vnd.amazon.ebook',
          'application/x-mobi8-ebook',
          'com.amazon.mobi',
          'com.amazon.azw3',
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

  const handleRecognize = useCallback(async () => {
    const engine = ocr.engineRef.current;
    if (!engine || !imageInfo) {
      setOcrRunError('Initialize OCR and extract images first.');
      return;
    }
    setOcrBusy(true);
    setOcrRunError(null);
    ocrAbortRef.current?.abort();
    const controller = new AbortController();
    ocrAbortRef.current = controller;
    await releaseOcrTextBuf();
    ocrProgressBoxRef.current?.reset();
    docDebug({
      phase: 'recognize',
      branch: 'start',
      frameCount: imageInfo.frameCount,
    });
    try {
      const textOut = await createEmptyOfflineTextBuffer();
      ocrTextBufRef.current = textOut;
      setOcrTextBufferId(textOut.bufferId);
      await engine.recognize(imageInfo.bufferId, textOut, {
        granularity: 'line',
        signal: controller.signal,
        onProgress: (p: OcrProgress) => {
          ocrProgressBoxRef.current?.apply(p);
        },
      });
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
      applyReadingOrder(resultText, spans, text, spatial, true);
      docDebug({
        phase: 'recognize',
        branch: 'ok',
        utf16Length: info.utf16Length,
        spanCount: spatial.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await releaseOcrTextBuf();
      applyReadingOrder(resultText, spans, '', [], true);
      if (msg.includes('CANCELLED') || msg.includes('cancelled')) {
        setOcrRunError('Recognize cancelled (OCR_CANCELLED).');
      } else {
        setOcrRunError(msg);
      }
      docDebug({ phase: 'recognize', branch: 'error', error: msg });
    } finally {
      ocrAbortRef.current = null;
      setOcrBusy(false);
      ocrProgressBoxRef.current?.reset();
    }
  }, [
    applyReadingOrder,
    imageInfo,
    ocr.engineRef,
    releaseOcrTextBuf,
    resultText,
    spans,
  ]);

  const startHighlightPoll = useCallback(
    (durationMs: number, speakText: string) => {
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
            if (!speakText) {
              return;
            }
            const fraction = Math.min(
              1,
              Math.max(0, positionMs / durationMsRef.current)
            );
            const cursor = Math.floor(fraction * speakText.length);
            if (readingBlocks.length > 0) {
              let idx = readingBlocks.findIndex(
                (block) => cursor >= block.utf16Start && cursor < block.utf16End
              );
              if (idx < 0) {
                idx = readingBlocks.findIndex(
                  (block) => cursor < block.utf16End
                );
              }
              setHighlightIndex(
                idx >= 0 ? idx : Math.max(0, readingBlocks.length - 1)
              );
              return;
            }
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
    [readingBlocks, spans]
  );

  const speakableText = joinedText || resultText;
  const canSpeak =
    (extractStatus === 'ok' || extractStatus === 'imagesOnly') &&
    speakableText.length > 0 &&
    Boolean(tts.selectedModelType);

  const handleSpeak = useCallback(async () => {
    const engine = tts.engineRef.current;
    if (!engine || !tts.selectedModelType) {
      setTtsError('Initialize a TTS model first.');
      return;
    }
    if (!canSpeak || !speakableText) {
      setTtsError('Extract readable text first.');
      return;
    }
    setSpeakBusy(true);
    setTtsError(null);
    await stopPlayback();
    await releaseAudioBuf();
    await releaseSpeakTextBuf();
    try {
      let textBuf: OfflineTextBufferRef | null = null;
      if (readingBlocks.length > 0) {
        textBuf = await createOfflineTextBufferFromText(speakableText);
        speakTextBufRef.current = textBuf;
      } else {
        textBuf = textBufRef.current;
      }
      if (!textBuf) {
        setTtsError('Extract readable text first.');
        return;
      }
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
      const lastIndex =
        readingBlocks.length > 0
          ? readingBlocks.length - 1
          : spans.length > 0
          ? spans.length - 1
          : 0;
      const player = await createPcmPlayer(audioBuf.bufferId, {
        onEnded: () => {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setPlaying(false);
          setHighlightIndex(lastIndex);
        },
      });
      playerRef.current = player;
      setPlaying(true);
      startHighlightPoll(durationMs, speakableText);
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpeakBusy(false);
    }
  }, [
    canSpeak,
    readingBlocks.length,
    releaseAudioBuf,
    releaseSpeakTextBuf,
    setTtsError,
    speakableText,
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

  const renderOriginBlocks = () => {
    if (readingBlocks.length === 0) {
      return (
        <Text style={styles.placeholder}>
          {extractStatus === 'imagesOnly'
            ? 'No markup. Extract images, initialize OCR, then Recognize.'
            : 'Pick a document to extract readable text.'}
        </Text>
      );
    }
    return (
      <View style={styles.originList}>
        {readingBlocks.map((block, index) => {
          const isOcr = block.origin === 'ocr';
          return (
            <View
              key={`${block.origin}-${block.sectionIndex}-${block.frameIndex}-${index}`}
              style={[
                styles.originBlock,
                isOcr ? styles.originBlockOcr : styles.originBlockMarkup,
              ]}
            >
              <View
                style={[
                  styles.originChip,
                  isOcr ? styles.originChipOcr : styles.originChipMarkup,
                ]}
              >
                <Text
                  style={[
                    styles.originChipText,
                    isOcr
                      ? styles.originChipTextOcr
                      : styles.originChipTextMarkup,
                  ]}
                >
                  {isOcr
                    ? `ocr · image ${block.frameIndex + 1}`
                    : `markup · section ${block.sectionIndex + 1}`}
                </Text>
              </View>
              <Text
                style={[
                  styles.bodyText,
                  highlightIndex === index && styles.highlight,
                ]}
              >
                {block.text}
              </Text>
            </View>
          );
        })}
      </View>
    );
  };

  const busy =
    extractBusy || imageExtractBusy || ocrBusy || speakBusy || ocr.initBusy;
  const imageProgressPercent =
    imageProgress && imageProgress.total > 0
      ? Math.round((100 * imageProgress.done) / imageProgress.total)
      : null;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenIntroModal screenId="Documents" />
        <View style={styles.header}>
          <Ionicons name="book-outline" size={48} style={styles.icon} />
          <Text style={styles.title}>Read aloud</Text>
          <Text style={styles.subtitle}>
            Extract EPUB / FB2 / DRM-free MOBI / AZW3 markup or a PDF text
            layer, then speak it with offline TTS. Mixed EPUBs and CBZ comics
            need an OCR model on this screen too (init, then Recognize). DRM
            Kindle files and scan-only PDFs cannot be read here.
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
          <Text style={styles.sectionTitle}>
            {sourceLabel ? 'Document' : 'Pick a document'}
          </Text>
          {sourceLabel ? null : (
            <Text style={styles.sectionHint}>
              Bundled text EPUB/FB2/MOBI/AZW3 and digital PDFs extract text.
              Mixed EPUB and CBZ unlock images — pick an OCR model below, then
              Recognize. DRM MOBI rejects without decrypting. Scan-only PDFs
              reject with no text layer (use Vision → OCR).
            </Text>
          )}
          <FileSourcePicker
            disabled={extractBusy}
            selectedLabel={sourceLabel}
            selectedDescription={
              DOCUMENT_FILES.find((file) => file.id === selectedId)
                ?.description ?? null
            }
            exampleListTitle="Choose an example document"
            ownPickButtonLabel="Pick EPUB, MOBI, CBZ, FB2, or PDF…"
            onPickOwn={() => {
              handleChooseFile().catch(() => {});
            }}
            renderExampleList={({ disabled, collapse }) => (
              <ExampleDocumentFileList
                files={DOCUMENT_FILES}
                selectedId={selectedId}
                onSelect={(file) => {
                  collapse();
                  handleExamplePick(file).catch(() => {});
                }}
                disabled={disabled}
              />
            )}
          />
        </View>

        {extractStatus === 'noTextLayer' ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionTitle}>No text layer</Text>
            <Text style={styles.sectionHint}>
              This PDF has no extractable text layer ({extractMessage}). Only
              OCR can continue — open Vision → OCR, pick the same scan PDF, and
              run recognize. This screen does not extract images from scan PDFs.
            </Text>
          </View>
        ) : null}

        {extractStatus === 'drm' ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionTitle}>DRM protected</Text>
            <Text style={styles.sectionHint}>
              This Kindle file is encrypted ({extractMessage}). The SDK does not
              decrypt DRM. Pick the DRM-free MOBI or AZW3 example, or another
              unlocked book.
            </Text>
          </View>
        ) : null}

        {extractStatus === 'imagesOnly' ? (
          <View style={styles.warnSection}>
            <Text style={styles.sectionTitle}>No extractable text</Text>
            <Text style={styles.sectionHint}>
              This file has no markup or text layer ({extractMessage}). Select
              and initialize an OCR model below, then tap Recognize. Pages are
              decoded as images only.
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

        {imageStepUnlocked ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Images</Text>
            <Text style={styles.sectionHint}>
              {extractStatus === 'imagesOnly'
                ? 'No markup in this file. Every comic page is an image — Recognize is required to get text.'
                : `Image preview is only the image-only spine (${
                    imageInfo?.frameCount ?? '…'
                  } ${
                    (imageInfo?.frameCount ?? 1) === 1 ? 'page' : 'pages'
                  }). Markup chapters (the text you already extracted) are not pictures, so they do not appear in this pager.`}
            </Text>
            {imageExtractBusy ? (
              <View style={styles.progressBox}>
                <Text style={styles.progressLabel}>
                  {imageProgress
                    ? `${imageProgress.phase} ${imageProgress.done}/${imageProgress.total}`
                    : 'extractDocumentImages…'}
                </Text>
                {imageProgressPercent != null ? (
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${imageProgressPercent}%` },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
            {imageInfo ? (
              <OfflineImageBufferFramePager
                buffer={imageInfo.bufferId}
                frameCount={imageInfo.frameCount}
                maxSide={1280}
                text={ocrTextBufferId ?? undefined}
              />
            ) : null}
            {ocrRunError ? (
              <Text style={styles.errorText}>{ocrRunError}</Text>
            ) : null}
          </View>
        ) : null}

        {imageStepUnlocked ? (
          <>
            <OcrModelInitPanel
              ocr={ocr}
              title="OCR model"
              disabled={busy}
              showScatteredTest={false}
            />
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recognize</Text>
              <Text style={styles.sectionHint}>
                Runs createOCR().recognize into a second text buffer. Markup and
                OCR stay separate until this screen joins them by sectionIndex.
              </Text>
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    styles.actionButtonFlex,
                    (!ocr.initializedFolder ||
                      !imageInfo ||
                      ocrBusy ||
                      imageExtractBusy) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={() => {
                    handleRecognize().catch(() => {});
                  }}
                  disabled={
                    !ocr.initializedFolder ||
                    !imageInfo ||
                    ocrBusy ||
                    imageExtractBusy
                  }
                >
                  {ocrBusy ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Recognize</Text>
                  )}
                </TouchableOpacity>
                {ocrBusy ? (
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.actionButtonFlex]}
                    onPress={() => {
                      ocrAbortRef.current?.abort();
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <OcrRecognizeProgressBox
                ref={ocrProgressBoxRef}
                family={ocr.engineFamily}
              />
            </View>
          </>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Extracted text</Text>
          {sourceLabel ? (
            <Text style={styles.meta}>
              {sourceLabel}
              {extractMessage &&
              (extractStatus === 'ok' || extractStatus === 'imagesOnly')
                ? ` · ${extractMessage}`
                : ''}
            </Text>
          ) : null}
          {extractBusy ? (
            <ActivityIndicator color="#007AFF" />
          ) : imageStepUnlocked ? (
            renderOriginBlocks()
          ) : (
            renderHighlightedText()
          )}
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (speakBusy || extractBusy || ocrBusy || !canSpeak) &&
                styles.buttonDisabled,
            ]}
            onPress={() => {
              handleSpeak().catch(() => {});
            }}
            disabled={speakBusy || extractBusy || ocrBusy || !canSpeak}
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
