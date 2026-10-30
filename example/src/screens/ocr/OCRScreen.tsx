import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  OCR_CAPABILITIES,
  OCR_DEFAULT_INSTRUCTIONS,
  type OcrDocVlmElement,
  type OcrGranularity,
  type OcrPaddleocrVlTask,
  type OcrContent,
  type OcrPixelRect,
  type OcrProgress,
  type OcrRecognizeResult,
  type OcrTaskOf,
  type OcrVlmRawMode,
} from 'react-native-sherpa-onnx/ocr';
import {
  extractPdfTextLayer,
  isPdfiumEnabled,
  PdfErrorCode,
} from 'react-native-sherpa-onnx/pdf';
import {
  OfflineImageBufferAnnotatedView,
  OfflineImageBufferFrameView,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferSpatialSpansSlice,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
  type TextSpatialSpan,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  OfflineImageBufferWidget,
  type OfflineImageBufferInfo,
  type OfflineImageBufferWidgetHandle,
  type PdfSourceSelection,
} from '../../components/OfflineImageBufferWidget';
import { OcrModelInitPanel } from '../../components/OcrModelInitPanel';
import {
  OcrRecognizeProgressBox,
  type OcrProgressBoxHandle,
} from '../../components/OcrRecognizeProgressBox';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { useOcrModelInit } from '../../hooks/useOcrModelInit';
import { IMAGE_FILES } from '../../imageConfig';
import { PDF_FILES } from '../../pdfConfig';
import { OcrInputPathLegend } from './OcrInputPathLegend';
import { styles } from './OCRScreen.styles';
import {
  collectOcrResultTabs,
  formatOcrElements,
  hasVlmRecognizeExtras,
  pickDefaultOcrResultTab,
  type OcrResultTab,
} from './ocrResultTabs';

type PdfExtractStatus = 'idle' | 'ok' | 'noTextLayer' | 'error';

function utf16Slice(text: string, start: number, end: number): string {
  // TextBuffer offsets are UTF-16 code units; string.slice matches for BMP text.
  return text.slice(start, end);
}

function spanSliceText(text: string, span: TextSpatialSpan): string {
  return utf16Slice(text, span.utf16Start, span.utf16End);
}

function joinSpanTexts(text: string, list: TextSpatialSpan[]): string {
  return list
    .map((span) => spanSliceText(text, span))
    .filter((slice) => slice.length > 0)
    .join('\n');
}

function parsePixelRect(
  x: string,
  y: string,
  w: string,
  h: string
): OcrPixelRect | null {
  if (!x && !y && !w && !h) return null;
  const nx = Number.parseInt(x, 10);
  const ny = Number.parseInt(y, 10);
  const nw = Number.parseInt(w, 10);
  const nh = Number.parseInt(h, 10);
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nw) ||
    !Number.isInteger(nh) ||
    nx < 0 ||
    ny < 0 ||
    nw <= 0 ||
    nh <= 0
  ) {
    return null;
  }
  return { x: nx, y: ny, width: nw, height: nh };
}

function contentTabLabel(content: OcrContent): string {
  if (content.format === 'code' && content.language) {
    return `Content (code/${content.language})`;
  }
  return `Content (${content.format})`;
}

function RectFieldRow({
  label,
  x,
  y,
  w,
  h,
  onX,
  onY,
  onW,
  onH,
  disabled,
}: {
  label: string;
  x: string;
  y: string;
  w: string;
  h: string;
  onX: (v: string) => void;
  onY: (v: string) => void;
  onW: (v: string) => void;
  onH: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.rectRow}>
        {(
          [
            ['x', x, onX],
            ['y', y, onY],
            ['width', w, onW],
            ['height', h, onH],
          ] as const
        ).map(([placeholder, value, onChange]) => (
          <TextInput
            key={placeholder}
            style={styles.rectInput}
            value={value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor="#94A3B8"
            keyboardType="number-pad"
            editable={!disabled}
          />
        ))}
      </View>
    </>
  );
}

export default function OCRScreen() {
  const abortRef = useRef<AbortController | null>(null);
  const ocr = useOcrModelInit({
    onBeforeInit: () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
  });
  const engineRef = ocr.engineRef;
  const initBusy = ocr.initBusy;
  const initializedFolder = ocr.initializedFolder;
  const engineFamily = ocr.engineFamily;
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<OfflineImageBufferInfo | null>(
    null
  );
  const [pdfSelection, setPdfSelection] = useState<PdfSourceSelection | null>(
    null
  );
  const [pdfExtractStatus, setPdfExtractStatus] =
    useState<PdfExtractStatus>('idle');
  const [pdfExtractMessage, setPdfExtractMessage] = useState<string | null>(
    null
  );
  const [pdfiumOn, setPdfiumOn] = useState<boolean | null>(null);
  const [resultText, setResultText] = useState('');
  const [resultMeta, setResultMeta] = useState<OcrRecognizeResult | null>(null);
  const [resultOrigin, setResultOrigin] = useState<'ocr' | 'textLayer' | null>(
    null
  );
  const [spans, setSpans] = useState<TextSpatialSpan[]>([]);
  const [selectedSpanIndex, setSelectedSpanIndex] = useState<number | null>(
    null
  );
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [resultTextBufferId, setResultTextBufferId] = useState<string | null>(
    null
  );
  const [resultFrameIndex, setResultFrameIndex] = useState(0);
  const [spansShowAllPages, setSpansShowAllPages] = useState(false);
  const [resultTab, setResultTab] = useState<OcrResultTab>('text');
  const [paddleocrVlTask, setPaddleocrVlTask] =
    useState<OcrPaddleocrVlTask>('ocr');
  const [graniteTask, setGraniteTask] = useState<OcrTaskOf<'doc_vlm'>>('page');
  const [graniteElement, setGraniteElement] =
    useState<OcrDocVlmElement>('table');
  const [granularity, setGranularity] = useState<OcrGranularity>('line');
  const [vlmRaw, setVlmRaw] = useState<OcrVlmRawMode>('accepted');
  const [cropX, setCropX] = useState('');
  const [cropY, setCropY] = useState('');
  const [cropW, setCropW] = useState('');
  const [cropH, setCropH] = useState('');
  const [regionX, setRegionX] = useState('');
  const [regionY, setRegionY] = useState('');
  const [regionW, setRegionW] = useState('');
  const [regionH, setRegionH] = useState('');
  const [lastMs, setLastMs] = useState<number | null>(null);
  const imageWidgetRef = useRef<OfflineImageBufferWidgetHandle>(null);
  const resultTextBufferIdRef = useRef<string | null>(null);
  const rasterBufferIdRef = useRef<string | null>(null);
  const progressBoxRef = useRef<OcrProgressBoxHandle>(null);

  useEffect(() => {
    isPdfiumEnabled()
      .then(setPdfiumOn)
      .catch(() => setPdfiumOn(false));
  }, []);

  useEffect(() => {
    const family = ocr.selectedFamily;
    if (!family) {
      return;
    }
    const allowed = OCR_CAPABILITIES[family]
      .granularities as readonly OcrGranularity[];
    const next = allowed[0] ?? 'line';
    if (!allowed.includes(granularity) && next !== granularity) {
      setGranularity(next);
    }
  }, [granularity, ocr.selectedFamily]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const resultTxt = resultTextBufferIdRef.current;
      resultTextBufferIdRef.current = null;
      if (resultTxt) {
        releasePipelineTextBuffer(resultTxt).catch(() => {});
      }
      const rasterId = rasterBufferIdRef.current;
      rasterBufferIdRef.current = null;
      if (rasterId) {
        releaseOfflineImageBuffer(rasterId).catch(() => {});
      }
    };
  }, []);

  const clearResults = useCallback(() => {
    setResultText('');
    setResultMeta(null);
    setResultOrigin(null);
    setSpans([]);
    setSelectedSpanIndex(null);
    setLastMs(null);
    progressBoxRef.current?.reset();
    setResultTab('text');
    setResultFrameIndex(0);
    setSpansShowAllPages(false);
    const id = resultTextBufferIdRef.current;
    resultTextBufferIdRef.current = null;
    setResultTextBufferId(null);
    if (id) {
      releasePipelineTextBuffer(id).catch(() => {});
    }
  }, []);

  const releaseResultTextBuffer = useCallback(async () => {
    const id = resultTextBufferIdRef.current;
    resultTextBufferIdRef.current = null;
    setResultTextBufferId(null);
    if (id) {
      await releasePipelineTextBuffer(id).catch(() => {});
    }
  }, []);

  const releaseRasterBuffer = useCallback(async () => {
    const id = rasterBufferIdRef.current;
    rasterBufferIdRef.current = null;
    if (id) {
      await releaseOfflineImageBuffer(id).catch(() => {});
    }
  }, []);

  const clearPdfState = useCallback(async () => {
    setPdfSelection(null);
    setPdfExtractStatus('idle');
    setPdfExtractMessage(null);
    await releaseResultTextBuffer();
    await releaseRasterBuffer();
  }, [releaseResultTextBuffer, releaseRasterBuffer]);

  const handlePdfSelected = useCallback(
    (selection: PdfSourceSelection) => {
      clearResults();
      // Widget already rasterized a preview buffer and called onBufferReady —
      // keep imageInfo; do not release the widget-owned buffer.
      setPdfSelection(selection);
      setPdfExtractStatus('idle');
      setPdfExtractMessage(null);
      releaseResultTextBuffer().catch(() => {});
      releaseRasterBuffer().catch(() => {});
    },
    [clearResults, releaseResultTextBuffer, releaseRasterBuffer]
  );

  const handleExtractPdf = useCallback(async () => {
    if (!pdfSelection) {
      setError('Select a PDF first.');
      return;
    }
    setRunBusy(true);
    setError(null);
    clearResults();
    await releaseResultTextBuffer();
    const t0 = Date.now();
    try {
      const enabled = await isPdfiumEnabled();
      setPdfiumOn(enabled);
      if (!enabled) {
        setPdfExtractStatus('error');
        setPdfExtractMessage(PdfErrorCode.PDFIUM_DISABLED);
        setError(
          `${PdfErrorCode.PDFIUM_DISABLED}: rebuild with sherpaOnnxEnablePdfium=true / SHERPA_ONNX_ENABLE_PDFIUM=1`
        );
        return;
      }
      const textOut = await createEmptyOfflineTextBuffer();
      resultTextBufferIdRef.current = textOut.bufferId;
      setResultTextBufferId(textOut.bufferId);
      const result = await extractPdfTextLayer(pdfSelection.source, textOut, {
        pages: 'all',
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
      setResultText(text);
      setResultMeta(null);
      setResultOrigin('textLayer');
      setSpans(spatial);
      setLastMs(Date.now() - t0);
      setResultTab(
        pickDefaultOcrResultTab({
          origin: 'textLayer',
          tabs: collectOcrResultTabs({
            origin: 'textLayer',
            resultText: text,
            spans: spatial,
          }),
        })
      );
      setPdfExtractStatus('ok');
      setPdfExtractMessage(
        `ok pages=${result.pageCount} withText=${result.pagesWithText} spans=${result.spatialSpanCount}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      const noTextLayer =
        code === PdfErrorCode.NO_TEXT_LAYER ||
        msg.includes(PdfErrorCode.NO_TEXT_LAYER);
      if (__DEV__) {
        console.log('[OCR] extractPdf catch', {
          code,
          msg,
          branch: noTextLayer ? 'noTextLayer' : 'error',
        });
      }
      await releaseResultTextBuffer();
      if (noTextLayer) {
        const strategy =
          imageInfo?.state === 'lazy'
            ? 'lazy-lru'
            : imageInfo?.state === 'immutable'
            ? 'rasterize-all'
            : null;
        setPdfExtractStatus('noTextLayer');
        setPdfExtractMessage(
          [
            PdfErrorCode.NO_TEXT_LAYER,
            imageInfo?.frameCount != null
              ? `frames=${imageInfo.frameCount}`
              : null,
            strategy,
          ]
            .filter(Boolean)
            .join(' · ')
        );
        setError(null);
      } else {
        setPdfExtractStatus('error');
        setPdfExtractMessage(msg);
        setError(msg);
      }
    } finally {
      setRunBusy(false);
    }
  }, [clearResults, imageInfo, pdfSelection, releaseResultTextBuffer]);

  const handleRecognize = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !imageInfo) {
      setError('Initialize OCR and load an image first.');
      return;
    }

    const needsRegion =
      engine.family === 'doc_vlm' &&
      (graniteTask === 'regionText' || graniteTask === 'identifyElement');
    const crop = needsRegion
      ? null
      : parsePixelRect(cropX, cropY, cropW, cropH);
    const cropPartial =
      !needsRegion && Boolean(cropX || cropY || cropW || cropH);
    if (cropPartial && !crop) {
      setError('Crop rect needs integer x,y ≥ 0 and width,height > 0.');
      return;
    }
    const region = parsePixelRect(regionX, regionY, regionW, regionH);
    if (needsRegion && !region) {
      setError(
        'regionText / identifyElement need a pixel region (x,y,width,height).'
      );
      return;
    }

    setRunBusy(true);
    setError(null);
    clearResults();
    await releaseResultTextBuffer();
    const controller = new AbortController();
    abortRef.current = controller;
    const t0 = Date.now();

    try {
      const textOut = await createEmptyOfflineTextBuffer();
      resultTextBufferIdRef.current = textOut.bufferId;
      setResultTextBufferId(textOut.bufferId);

      const shared = {
        granularity,
        signal: controller.signal,
        onProgress: (p: OcrProgress) => {
          progressBoxRef.current?.apply(p);
        },
        ...(crop ? { crop } : {}),
        ...(engine.family === 'doc_vlm' ? { raw: vlmRaw } : {}),
      };
      const page =
        engine.family === 'paddleocr_vl'
          ? await engine.recognize(imageInfo.bufferId, textOut, {
              ...shared,
              instruction: { task: paddleocrVlTask },
            })
          : engine.family === 'doc_vlm'
          ? graniteTask === 'element'
            ? await engine.recognize(imageInfo.bufferId, textOut, {
                ...shared,
                instruction: { task: 'element', element: graniteElement },
              })
            : graniteTask === 'regionText' || graniteTask === 'identifyElement'
            ? await engine.recognize(imageInfo.bufferId, textOut, {
                ...shared,
                instruction: {
                  task: graniteTask,
                  region: region!,
                },
              })
            : await engine.recognize(imageInfo.bufferId, textOut, {
                ...shared,
                instruction: { task: 'page' },
              })
          : engine.family === 'nemotron_parse'
          ? await engine.recognize(imageInfo.bufferId, textOut, {
              ...shared,
              instruction: OCR_DEFAULT_INSTRUCTIONS.nemotron_parse,
            })
          : await engine.recognize(imageInfo.bufferId, textOut, shared);

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
      setResultMeta(page);
      setResultOrigin('ocr');
      setSpans(spatial);
      setLastMs(Date.now() - t0);
      const vlm = hasVlmRecognizeExtras(page) ? page : null;
      const tabs = collectOcrResultTabs({
        origin: 'ocr',
        resultText: text,
        spans: spatial,
        content: vlm?.content,
        raw: vlm?.raw,
        elements: vlm?.elements,
        includeRawTab: vlm != null,
      });
      if (__DEV__) {
        console.log('[OCR] recognize result', {
          family: page.family,
          spanCount: page.spanCount,
          textLen: text.length,
          spatial: spatial.length,
          rawLen: vlm?.raw.length ?? 0,
          contentLen: vlm?.content?.value.length ?? 0,
          elements: vlm?.elements.length ?? 0,
          complete: vlm?.complete,
          stopReason: vlm?.stopReason,
          tabs,
        });
      }
      setResultTab(
        pickDefaultOcrResultTab({
          origin: 'ocr',
          family: page.family,
          paddleocrVlTask:
            page.family === 'paddleocr_vl' ? page.instruction.task : undefined,
          incomplete: vlm != null && !vlm.complete,
          tabs,
        })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await releaseResultTextBuffer();
      if (msg.includes('CANCELLED') || msg.includes('cancelled')) {
        setError('Recognize cancelled (OCR_CANCELLED).');
      } else {
        setError(msg);
      }
    } finally {
      abortRef.current = null;
      setRunBusy(false);
      progressBoxRef.current?.reset();
    }
  }, [
    clearResults,
    engineRef,
    imageInfo,
    paddleocrVlTask,
    graniteTask,
    graniteElement,
    granularity,
    vlmRaw,
    cropX,
    cropY,
    cropW,
    cropH,
    regionX,
    regionY,
    regionW,
    regionH,
    releaseResultTextBuffer,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resultPageCount = useMemo(() => {
    const fromBuffer = imageInfo?.frameCount ?? 0;
    const fromSpans =
      spans.length > 0
        ? Math.max(...spans.map((span) => span.frameIndex)) + 1
        : 0;
    return Math.max(fromBuffer, fromSpans, 1);
  }, [imageInfo?.frameCount, spans]);

  useEffect(() => {
    setResultFrameIndex((i) =>
      Math.min(Math.max(0, i), Math.max(0, resultPageCount - 1))
    );
  }, [resultPageCount, imageInfo?.bufferId]);

  const multiPage = resultPageCount > 1;
  const scopedSpans = spansShowAllPages
    ? spans
    : spans.filter((span) => span.frameIndex === resultFrameIndex);
  const scopedSpanText = joinSpanTexts(resultText, scopedSpans);

  const vlmExtras = hasVlmRecognizeExtras(resultMeta) ? resultMeta : null;
  const elementKindCounts = useMemo(() => {
    if (!vlmExtras || vlmExtras.elements.length === 0) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const el of vlmExtras.elements) {
      counts.set(el.kind, (counts.get(el.kind) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [vlmExtras]);
  const resultTabs = useMemo(
    () =>
      collectOcrResultTabs({
        origin: resultOrigin,
        resultText,
        spans,
        content: vlmExtras?.content,
        raw: vlmExtras?.raw,
        elements: vlmExtras?.elements,
        includeRawTab: vlmExtras != null,
      }),
    [resultOrigin, resultText, spans, vlmExtras]
  );
  const resultTabItems = resultTabs.map((id): [OcrResultTab, string] => {
    if (id === 'spans') return ['spans', `Spans (${spans.length})`];
    if (id === 'text') return ['text', 'Text'];
    if (id === 'content') {
      return [
        'content',
        vlmExtras?.content ? contentTabLabel(vlmExtras.content) : 'Content',
      ];
    }
    if (id === 'raw') return ['raw', 'Raw'];
    return ['elements', `Elements (${vlmExtras?.elements.length ?? 0})`];
  });
  const activeResultTab = resultTabs.includes(resultTab)
    ? resultTab
    : resultTabs[0] ?? 'text';
  const extrasPayload =
    activeResultTab === 'raw'
      ? vlmExtras?.raw ?? ''
      : activeResultTab === 'elements'
      ? formatOcrElements(vlmExtras?.elements ?? [])
      : activeResultTab === 'content'
      ? vlmExtras?.content?.value ?? ''
      : resultText;
  const showingSpanList = activeResultTab === 'spans';

  const showPdfPipeline = pdfSelection != null;
  const showRasterStep = pdfExtractStatus === 'noTextLayer';
  const showRecognizeStep =
    !showPdfPipeline || (showRasterStep && imageInfo != null);
  const showResults =
    resultOrigin === 'textLayer' || resultMeta != null || resultTabs.length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="OCR" />
      <ScrollView contentContainerStyle={styles.content}>
        <OcrModelInitPanel
          ocr={ocr}
          title="1. OCR model"
          disabled={runBusy}
          onSelectFolder={() => {
            clearResults();
          }}
          recognize={{
            paddleocrVlTask,
            setPaddleocrVlTask,
            graniteTask,
            setGraniteTask,
            graniteElement,
            setGraniteElement,
            granularity,
            setGranularity,
            vlmRaw,
            setVlmRaw,
          }}
        />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. Input (image or PDF)</Text>
          <OcrInputPathLegend pdfiumOn={pdfiumOn} />
          {initializedFolder ? (
            <>
              <Text style={styles.sectionHint}>
                Pick a fixture below. Paths, spans, and overlay rules are in the
                legend above.
              </Text>
              <OfflineImageBufferWidget
                ref={imageWidgetRef}
                imageFiles={IMAGE_FILES}
                pdfFiles={PDF_FILES}
                visible
                disabled={runBusy || initBusy}
                onBufferReady={(info) => {
                  if (info.kind !== 'pdf') {
                    clearPdfState().catch(() => {});
                  }
                  setImageInfo(info);
                  clearResults();
                }}
                onBufferReleased={() => {
                  setImageInfo(null);
                  clearResults();
                }}
                onPdfSelected={handlePdfSelected}
                onPdfCleared={() => {
                  clearPdfState().catch(() => {});
                  setImageInfo(null);
                  clearResults();
                }}
              />
            </>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                Initialize an OCR engine above to enable the input picker.
              </Text>
            </View>
          )}
        </View>

        {showPdfPipeline ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2b. extractPdfTextLayer</Text>
            <Text style={styles.sectionHint}>
              Selected: {pdfSelection?.label}
            </Text>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                (runBusy || !pdfSelection) && styles.primaryButtonDisabled,
              ]}
              onPress={() => {
                handleExtractPdf().catch(() => {});
              }}
              disabled={runBusy || !pdfSelection}
            >
              {runBusy && !showRasterStep && !imageInfo ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  Run extractPdfTextLayer
                </Text>
              )}
            </TouchableOpacity>
            {pdfExtractMessage ? (
              <Text style={styles.mono}>status: {pdfExtractMessage}</Text>
            ) : null}
            {error && !showRecognizeStep ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : null}
          </View>
        ) : null}

        {showRasterStep ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. No text layer</Text>
            <Text style={styles.sectionHint}>
              This PDF has no extractable text layer. Call recognize on the
              OfflineImageBuffer that already holds the rasterized pages.
            </Text>
          </View>
        ) : null}

        {showRecognizeStep ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {showPdfPipeline ? '4. Recognize' : '3. Recognize'}
            </Text>
            {ocr.selectedFamily === 'doc_vlm' &&
            (graniteTask === 'regionText' ||
              graniteTask === 'identifyElement') ? (
              <>
                <Text style={styles.sectionHint}>
                  Crop is disabled for region tasks (crop + region is rejected).
                  Set instruction.task above, then the pixel region here.
                </Text>
                <RectFieldRow
                  label="instruction.region (pixels)"
                  x={regionX}
                  y={regionY}
                  w={regionW}
                  h={regionH}
                  onX={setRegionX}
                  onY={setRegionY}
                  onW={setRegionW}
                  onH={setRegionH}
                  disabled={runBusy}
                />
              </>
            ) : ocr.selectedFamily != null ? (
              <RectFieldRow
                label="crop (optional pixels; empty = full frame)"
                x={cropX}
                y={cropY}
                w={cropW}
                h={cropH}
                onX={setCropX}
                onY={setCropY}
                onW={setCropW}
                onH={setCropH}
                disabled={runBusy}
              />
            ) : (
              <Text style={styles.sectionHint}>
                Select and initialize a pack in section 1. instruction.task
                lives there with the other family fields.
              </Text>
            )}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.actionButtonFlex,
                  (!initializedFolder || !imageInfo || runBusy) &&
                    styles.primaryButtonDisabled,
                ]}
                onPress={() => {
                  handleRecognize().catch(() => {});
                }}
                disabled={!initializedFolder || !imageInfo || runBusy}
              >
                {runBusy && showRecognizeStep ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>Run OCR</Text>
                )}
              </TouchableOpacity>
              {runBusy ? (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.actionButtonFlex]}
                  onPress={handleCancel}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <OcrRecognizeProgressBox
              ref={progressBoxRef}
              family={engineFamily}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : null}

        {showResults ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {showPdfPipeline
                ? showRasterStep
                  ? '5. Results'
                  : '3. Results'
                : '4. Results'}
            </Text>
            <View style={styles.card}>
              <Text style={styles.mono}>
                origin={resultOrigin ?? 'ocr'}
                {resultMeta
                  ? `\nfamily=${resultMeta.family}\nspanCount=${resultMeta.spanCount}`
                  : `\nspanCount=${spans.length}`}
                {vlmExtras
                  ? `\ninstruction=${JSON.stringify(
                      vlmExtras.instruction
                    )}\ncontent.format=${vlmExtras.content?.format ?? 'null'}${
                      vlmExtras.content?.format === 'code'
                        ? ` language=${vlmExtras.content.language ?? 'null'}`
                        : ''
                    }\nelements=${vlmExtras.elements.length}${
                      elementKindCounts.length > 0
                        ? ` (${elementKindCounts
                            .map(([kind, n]) => `${kind}:${n}`)
                            .join(', ')})`
                        : ''
                    }\ncomplete=${vlmExtras.complete}\nstopReason=${
                      vlmExtras.stopReason
                    }`
                  : ''}
                {lastMs != null ? `\nwall=${lastMs}ms` : ''}
                {imageInfo
                  ? `\nframe=${imageInfo.width}×${imageInfo.height}`
                  : ''}
              </Text>
              {vlmExtras != null && !vlmExtras.complete ? (
                <Text style={styles.sectionHint}>
                  Incomplete generation ({vlmExtras.stopReason}). Raw output is
                  still on the Raw tab.
                </Text>
              ) : null}
            </View>

            {imageInfo?.bufferId ? (
              <View>
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>
                    Spatial overlay (ocr + textLayer)
                  </Text>
                  {spans.length > 0 && resultTextBufferId ? (
                    <Switch
                      value={overlayEnabled}
                      onValueChange={setOverlayEnabled}
                    />
                  ) : null}
                </View>
                {overlayEnabled && resultTextBufferId && spans.length > 0 ? (
                  <OfflineImageBufferAnnotatedView
                    buffer={imageInfo.bufferId}
                    text={resultTextBufferId}
                    frameIndex={resultFrameIndex}
                    selectedIndex={selectedSpanIndex}
                    originBoxStyle={{
                      ocr: {
                        borderColor: '#007AFF',
                        backgroundColor: 'rgba(0, 122, 255, 0.28)',
                      },
                      textLayer: {
                        borderColor: '#34C759',
                        backgroundColor: 'rgba(52, 199, 89, 0.28)',
                      },
                    }}
                    onSpanPress={(event) => {
                      setResultTab('spans');
                      setSelectedSpanIndex(
                        selectedSpanIndex === event.index ? null : event.index
                      );
                    }}
                    maxSide={1280}
                    style={styles.resultPreview}
                  />
                ) : (
                  <OfflineImageBufferFrameView
                    buffer={imageInfo.bufferId}
                    frameIndex={resultFrameIndex}
                    maxSide={1280}
                    resizeMode="contain"
                    style={styles.resultPreview}
                  />
                )}
                {overlayEnabled && resultTextBufferId && spans.length > 0 ? (
                  <Text style={styles.sectionHint}>
                    Tap a box to highlight that span in the list below. Blue =
                    ocr, green = textLayer.
                  </Text>
                ) : null}
              </View>
            ) : null}
            {multiPage ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    styles.actionButtonFlex,
                    resultFrameIndex <= 0 && styles.primaryButtonDisabled,
                  ]}
                  disabled={resultFrameIndex <= 0}
                  onPress={() => setResultFrameIndex((i) => Math.max(0, i - 1))}
                >
                  <Text style={styles.primaryButtonText}>Previous</Text>
                </TouchableOpacity>
                <Text style={styles.toggleLabel}>
                  Page {resultFrameIndex + 1} / {resultPageCount}
                  {overlayEnabled && resultTextBufferId
                    ? ` · ${
                        spans.filter((s) => s.frameIndex === resultFrameIndex)
                          .length
                      } spans`
                    : ''}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    styles.actionButtonFlex,
                    resultFrameIndex >= resultPageCount - 1 &&
                      styles.primaryButtonDisabled,
                  ]}
                  disabled={resultFrameIndex >= resultPageCount - 1}
                  onPress={() =>
                    setResultFrameIndex((i) =>
                      Math.min(resultPageCount - 1, i + 1)
                    )
                  }
                >
                  <Text style={styles.primaryButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {resultTabs.length > 0 ? (
              <View style={styles.card}>
                {resultTabItems.length > 1 ? (
                  <View style={styles.toggleRow}>
                    <View style={styles.tabRowInline}>
                      {resultTabItems.map(([id, label]) => (
                        <TouchableOpacity
                          key={id}
                          style={[
                            styles.tab,
                            activeResultTab === id && styles.tabActive,
                          ]}
                          onPress={() => setResultTab(id)}
                        >
                          <Text
                            style={[
                              styles.tabText,
                              activeResultTab === id && styles.tabTextActive,
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                ) : null}

                {showingSpanList ? (
                  <>
                    <View style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>
                        Spans ({scopedSpans.length}
                        {spansShowAllPages
                          ? ` · ${spans.length} total`
                          : ` · page ${resultFrameIndex + 1}`}
                        )
                      </Text>
                      <View style={styles.toggleTrailing}>
                        {multiPage ? (
                          <>
                            <Text style={styles.sectionHint}>All pages</Text>
                            <Switch
                              value={spansShowAllPages}
                              onValueChange={setSpansShowAllPages}
                            />
                          </>
                        ) : null}
                        <TouchableOpacity
                          style={styles.copyChip}
                          onPress={() =>
                            Clipboard.setString(
                              scopedSpanText.length > 0
                                ? scopedSpanText
                                : resultText
                            )
                          }
                          accessibilityLabel="Copy all span text"
                        >
                          <Ionicons
                            name="copy-outline"
                            size={16}
                            color="#007AFF"
                          />
                          <Text style={styles.copyChipLabel}>Copy all</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    {scopedSpans.map((span) => {
                      const index = spans.indexOf(span);
                      const active = selectedSpanIndex === index;
                      const slice = spanSliceText(resultText, span);
                      return (
                        <View
                          key={`list-${index}`}
                          style={[
                            styles.spanRow,
                            active && styles.spanRowActive,
                          ]}
                        >
                          <TouchableOpacity
                            style={styles.spanRowBody}
                            onPress={() => {
                              setSelectedSpanIndex(active ? null : index);
                              setResultFrameIndex(span.frameIndex);
                            }}
                          >
                            <Text style={styles.resultText} numberOfLines={2}>
                              {slice || '(empty slice)'}
                            </Text>
                            <Text style={styles.spanMeta}>
                              #{index} frame {span.frameIndex + 1} {span.level}{' '}
                              conf=
                              {(span.confidence ?? 0).toFixed(2)} utf16=
                              {span.utf16Start}-{span.utf16End} quad=
                              {span.quad.map((n) => Math.round(n)).join(',')}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.spanCopyButton}
                            onPress={() => Clipboard.setString(slice)}
                            accessibilityLabel={`Copy span ${index}`}
                            hitSlop={8}
                          >
                            <Ionicons
                              name="copy-outline"
                              size={18}
                              color="#007AFF"
                            />
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <View style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>
                        {activeResultTab === 'raw'
                          ? 'Raw'
                          : activeResultTab === 'elements'
                          ? 'Elements'
                          : activeResultTab === 'content' && vlmExtras?.content
                          ? contentTabLabel(vlmExtras.content)
                          : 'Text'}
                      </Text>
                      <TouchableOpacity
                        style={styles.copyChip}
                        onPress={() => Clipboard.setString(extrasPayload)}
                        accessibilityLabel={`Copy ${activeResultTab}`}
                      >
                        <Ionicons
                          name="copy-outline"
                          size={16}
                          color="#007AFF"
                        />
                        <Text style={styles.copyChipLabel}>Copy</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.resultText} selectable>
                      {extrasPayload ||
                        (activeResultTab === 'raw'
                          ? `(empty raw${
                              vlmExtras && !vlmExtras.complete
                                ? `, ${vlmExtras.stopReason}`
                                : ''
                            })`
                          : '(empty)')}
                    </Text>
                  </>
                )}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
