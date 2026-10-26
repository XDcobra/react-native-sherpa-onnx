import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  assertOcrCustomConfig,
  createOCR,
  detectOcrModel,
  type OcrCustomConfig,
  type OcrEngine,
  type OcrInitializeOptions,
  type OcrProgress,
  type OcrRecognizeResult,
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
  DocVlmInitOptionChips,
  InitModeSelector,
  ModelFolderGrid,
  OcrCustomInitForm,
  type ModelInitMode,
  type OcrCustomInitFormState,
} from '../../components/modelInit';
import {
  OfflineImageBufferWidget,
  type OfflineImageBufferInfo,
  type OfflineImageBufferWidgetHandle,
  type PdfSourceSelection,
} from '../../components/OfflineImageBufferWidget';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { useOcrModelCatalog } from '../../hooks/useOcrModelCatalog';
import { IMAGE_FILES } from '../../imageConfig';
import { PDF_FILES } from '../../pdfConfig';
import { getModelDisplayName, toDetectSource } from '../../modelConfig';
import { useDeviceProviders } from '../../providers/DeviceProvidersContext';
import {
  emptyOcrCustomInitFormState,
  fillOcrCustomConfigFromModelFolder,
} from '../../utils/ocrCustomInitFill';
import { OcrInputPathLegend } from './OcrInputPathLegend';
import { styles } from './OCRScreen.styles';

type PdfExtractStatus = 'idle' | 'ok' | 'noTextLayer' | 'error';

const MIN_THREADS = 1;
const MAX_THREADS = 8;
const MIN_UNCLIP = 1.0;
const MAX_UNCLIP = 2.5;
const DEFAULT_UNCLIP = 1.5;

function isGranitePack(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('docvlm') || lower.includes('granite');
}

function utf16Slice(text: string, start: number, end: number): string {
  // TextBuffer offsets are UTF-16 code units; string.slice matches for BMP text.
  return text.slice(start, end);
}

function textForFrame(
  text: string,
  spans: TextSpatialSpan[],
  frameIndex: number
): string {
  return spans
    .filter((span) => span.frameIndex === frameIndex)
    .map((span) => utf16Slice(text, span.utf16Start, span.utf16End))
    .filter((slice) => slice.length > 0)
    .join('\n');
}

function HighlightedResultText({
  fullText,
  spans,
  selectedIndex,
  pageOnly,
  frameIndex,
}: {
  fullText: string;
  spans: TextSpatialSpan[];
  selectedIndex: number | null;
  pageOnly: boolean;
  frameIndex: number;
}) {
  if (pageOnly) {
    const pageSpans = spans
      .map((span, index) => ({ span, index }))
      .filter(({ span }) => span.frameIndex === frameIndex);
    if (pageSpans.length === 0) {
      return <Text style={styles.resultText}>(empty text)</Text>;
    }
    return (
      <Text style={styles.resultText}>
        {pageSpans.map(({ span, index }, i) => {
          const slice = utf16Slice(fullText, span.utf16Start, span.utf16End);
          return (
            <Text key={index}>
              {i > 0 ? '\n' : ''}
              <Text
                style={
                  selectedIndex === index
                    ? styles.resultTextHighlight
                    : undefined
                }
              >
                {slice}
              </Text>
            </Text>
          );
        })}
      </Text>
    );
  }

  const selected = selectedIndex != null ? spans[selectedIndex] ?? null : null;
  if (!selected || fullText.length === 0) {
    return <Text style={styles.resultText}>{fullText || '(empty text)'}</Text>;
  }
  const start = Math.max(0, selected.utf16Start);
  const end = Math.min(fullText.length, selected.utf16End);
  return (
    <Text style={styles.resultText}>
      {fullText.slice(0, start)}
      <Text style={styles.resultTextHighlight}>
        {fullText.slice(start, end)}
      </Text>
      {fullText.slice(end)}
    </Text>
  );
}

function clampUnclipRatio(value: number): number {
  const clamped = Math.min(MAX_UNCLIP, Math.max(MIN_UNCLIP, value));
  return Math.round(clamped * 20) / 20; // 0.05 steps
}

export default function OCRScreen() {
  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useOcrModelCatalog();
  const { selectableApiIds: providerOptions, status: providerStatus } =
    useDeviceProviders();
  const providersLoading =
    providerStatus === 'loading' || providerStatus === 'idle';
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [initializedFolder, setInitializedFolder] = useState<string | null>(
    null
  );
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<OcrCustomInitFormState>(
    () => emptyOcrCustomInitFormState()
  );
  const [fillLoading, setFillLoading] = useState(false);
  const [fillHint, setFillHint] = useState<string | null>(null);
  const [numThreads, setNumThreads] = useState(2);
  const [provider, setProvider] = useState('cpu');
  const [detUnclipRatio, setDetUnclipRatio] = useState(DEFAULT_UNCLIP);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initMessage, setInitMessage] = useState<string | null>(null);
  const [detectSummary, setDetectSummary] = useState<string | null>(null);
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
  const [textShowAllPages, setTextShowAllPages] = useState(false);
  const [spansShowAllPages, setSpansShowAllPages] = useState(false);
  const [resultTab, setResultTab] = useState<'text' | 'markdown' | 'doctags'>(
    'text'
  );
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const engineRef = useRef<OcrEngine | null>(null);
  const imageWidgetRef = useRef<OfflineImageBufferWidgetHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultTextBufferIdRef = useRef<string | null>(null);
  const rasterBufferIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedFolder && catalogEntries.some((e) => e.id === selectedFolder)) {
      return;
    }
    const tiny = catalogEntries.find((e) =>
      e.id.toLowerCase().includes('ppocrv6-tiny')
    );
    setSelectedFolder(tiny?.id ?? catalogEntries[0]?.id ?? null);
  }, [catalogEntries, selectedFolder]);

  useEffect(() => {
    if (catalogError) {
      setError(catalogError);
    }
  }, [catalogError]);

  useEffect(() => {
    if (providerOptions.length === 0) {
      setProvider('cpu');
      return;
    }
    setProvider((prev) =>
      providerOptions.includes(prev) ? prev : providerOptions[0]!
    );
  }, [providerOptions]);

  useEffect(() => {
    isPdfiumEnabled()
      .then(setPdfiumOn)
      .catch(() => setPdfiumOn(false));
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const engine = engineRef.current;
      engineRef.current = null;
      engine?.destroy().catch(() => {});
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

  const destroyEngine = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    const engine = engineRef.current;
    engineRef.current = null;
    setInitializedFolder(null);
    setInitMessage(null);
    setDetectSummary(null);
    if (engine) {
      await engine.destroy().catch(() => {});
    }
  }, []);

  const runDetect = useCallback(
    async (modelId: string) => {
      const modelSource = await toDetectSource(resolveModelPath(modelId));
      const det = await detectOcrModel(modelSource, { modelType: 'auto' });
      setDetectSummary(
        det.success
          ? `detect: modelType=${det.modelType ?? '?'}`
          : `detect failed: ${det.error ?? 'unknown'}`
      );
      return det;
    },
    [resolveModelPath]
  );

  const handleFillFromSelectedModel = useCallback(async () => {
    if (!selectedFolder) {
      Alert.alert('Select a model', 'Pick an OCR pack from the catalog first.');
      return;
    }
    setFillLoading(true);
    setFillHint(null);
    setError(null);
    try {
      const fillResult = await fillOcrCustomConfigFromModelFolder(
        await toDetectSource(resolveModelPath(selectedFolder))
      );
      setCustomInitForm((prev) => ({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
        maxNewTokens: prev.maxNewTokens,
      }));
      const missing =
        fillResult.missingKeys.length > 0
          ? ` Missing: ${fillResult.missingKeys.join(', ')}`
          : '';
      setFillHint(
        `Filled from ${getModelDisplayName(selectedFolder)}.${missing}`
      );
    } catch (err) {
      setFillHint(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFillLoading(false);
    }
  }, [resolveModelPath, selectedFolder]);

  const handleInit = useCallback(async () => {
    const threads = Math.min(MAX_THREADS, Math.max(MIN_THREADS, numThreads));
    const providerValue = provider.trim() || 'cpu';

    const proceedAuto = async (folderId: string) => {
      setInitBusy(true);
      setError(null);
      setInitMessage(null);
      try {
        await destroyEngine();
        const modelSource = await toDetectSource(resolveModelPath(folderId));
        await runDetect(folderId);

        const wantDocVlmOpts = isGranitePack(folderId);
        const maxLabel =
          customInitForm.maxNewTokens === 0
            ? 'default'
            : String(customInitForm.maxNewTokens);
        const initOptions: OcrInitializeOptions = {
          modelSource,
          modelType: 'auto',
          provider: providerValue,
          numThreads: threads,
          ppocr: { detUnclipRatio },
          doctr: { detUnclipRatio },
          ...(wantDocVlmOpts
            ? { docVlm: { maxNewTokens: customInitForm.maxNewTokens } }
            : {}),
        };
        const ocr = await createOCR(initOptions);
        engineRef.current = ocr;
        setInitializedFolder(folderId);
        setInitMessage(
          `Ready · instance=${
            ocr.instanceId
          } · modelType=auto · ${getModelDisplayName(folderId)}${
            wantDocVlmOpts ? ` · maxNewTokens=${maxLabel}` : ''
          }`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInitBusy(false);
      }
    };

    const proceedCustom = async () => {
      setInitBusy(true);
      setError(null);
      setInitMessage(null);
      try {
        await destroyEngine();
        const customConfig = {
          ...customInitForm.fileSources,
        } as OcrCustomConfig;
        assertOcrCustomConfig(
          customConfig as unknown as Record<string, unknown>
        );
        const wantDocVlmOpts = customInitForm.modelType === 'doc_vlm';
        const ocr = await createOCR({
          initMode: 'custom',
          modelType: customInitForm.modelType,
          customConfig,
          provider: providerValue,
          numThreads: threads,
          ...(customInitForm.modelType === 'ppocr'
            ? { ppocr: { detUnclipRatio } }
            : {}),
          ...(customInitForm.modelType === 'doctr'
            ? { doctr: { detUnclipRatio } }
            : {}),
          ...(wantDocVlmOpts
            ? { docVlm: { maxNewTokens: customInitForm.maxNewTokens } }
            : {}),
        });
        engineRef.current = ocr;
        setInitializedFolder(
          selectedFolder
            ? `custom:${selectedFolder}`
            : `custom:${customInitForm.modelType}`
        );
        const maxLabel =
          customInitForm.maxNewTokens === 0
            ? 'default'
            : String(customInitForm.maxNewTokens);
        setInitMessage(
          `Ready · instance=${ocr.instanceId} · custom:${
            customInitForm.modelType
          }${wantDocVlmOpts ? ` · maxNewTokens=${maxLabel}` : ''}`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInitBusy(false);
      }
    };

    if (initMode === 'custom') {
      await proceedCustom();
      return;
    }

    if (!selectedFolder) {
      setError('Select an OCR pack (assets, PAD, or Download Manager → OCR).');
      return;
    }

    if (isGranitePack(selectedFolder)) {
      Alert.alert(
        'Large Doc-VLM pack',
        'docvlm-granite-258m is ~420 MiB compressed / ~1.2 GiB unpacked and needs significant RAM. Mobile ORT must include com.microsoft.GroupQueryAttention. Continue?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Initialize',
            onPress: () => {
              proceedAuto(selectedFolder).catch(() => {});
            },
          },
        ]
      );
      return;
    }

    await proceedAuto(selectedFolder);
  }, [
    customInitForm.fileSources,
    customInitForm.maxNewTokens,
    customInitForm.modelType,
    destroyEngine,
    detUnclipRatio,
    initMode,
    numThreads,
    provider,
    resolveModelPath,
    runDetect,
    selectedFolder,
  ]);

  const unclipTrackWidthRef = useRef(0);

  const applyUnclipFromLocationX = useCallback(
    (locationX: number) => {
      if (initBusy || runBusy) return;
      const width = unclipTrackWidthRef.current;
      if (width <= 0) return;
      const x = Math.max(0, Math.min(width, locationX));
      const t = x / width;
      setDetUnclipRatio(
        clampUnclipRatio(MIN_UNCLIP + t * (MAX_UNCLIP - MIN_UNCLIP))
      );
    },
    [initBusy, runBusy]
  );

  const onUnclipTouch = useCallback(
    (event: GestureResponderEvent) => {
      applyUnclipFromLocationX(event.nativeEvent.locationX);
    },
    [applyUnclipFromLocationX]
  );

  const onUnclipSliderLayout = useCallback((event: LayoutChangeEvent) => {
    unclipTrackWidthRef.current = event.nativeEvent.layout.width;
  }, []);

  const unclipSliderDisabled = initBusy || runBusy;

  const clearResults = useCallback(() => {
    setResultText('');
    setResultMeta(null);
    setResultOrigin(null);
    setSpans([]);
    setSelectedSpanIndex(null);
    setLastMs(null);
    setProgressLabel(null);
    setProgressPercent(null);
    setResultTab('text');
    setResultFrameIndex(0);
    setTextShowAllPages(false);
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

      const page = await engine.recognize(imageInfo.bufferId, textOut, {
        granularity: 'line',
        signal: controller.signal,
        onProgress: (p: OcrProgress) => {
          setProgressLabel(`${p.phase} (${p.done}/${p.total})`);
          setProgressPercent(
            p.total > 0 ? Math.round((100 * p.done) / p.total) : null
          );
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

      setResultText(text);
      setResultMeta(page);
      setResultOrigin('ocr');
      setSpans(spatial);
      setLastMs(Date.now() - t0);
      if (page.family === 'doc_vlm' && page.markdown.trim().length > 0) {
        setResultTab('markdown');
      }
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
      setProgressLabel(null);
      setProgressPercent(null);
    }
  }, [clearResults, imageInfo, releaseResultTextBuffer]);

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
  const scopedText = textShowAllPages
    ? resultText
    : textForFrame(resultText, spans, resultFrameIndex);

  const docVlmExtras = resultMeta?.family === 'doc_vlm' ? resultMeta : null;
  const showDocVlmTabs =
    textShowAllPages &&
    docVlmExtras != null &&
    (docVlmExtras.markdown.length > 0 || docVlmExtras.doctags.length > 0);

  const showPdfPipeline = pdfSelection != null;
  const showRasterStep = pdfExtractStatus === 'noTextLayer';
  const showRecognizeStep =
    !showPdfPipeline || (showRasterStep && imageInfo != null);
  const showResults =
    resultOrigin === 'textLayer' || resultMeta != null || spans.length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="OCR" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. OCR model</Text>
          <Text style={styles.sectionHint}>
            Recommended start: ppocrv6-tiny (bundled assets or Download Manager
            → OCR).
          </Text>

          <View style={styles.sectionBody}>
            <InitModeSelector
              value={initMode}
              onChange={setInitMode}
              disabled={initBusy || runBusy}
            />

            {initMode === 'auto' ? (
              <>
                <ModelFolderGrid
                  entries={catalogEntries}
                  selectedId={selectedFolder}
                  initializedId={
                    initializedFolder?.startsWith('custom:')
                      ? null
                      : initializedFolder
                  }
                  onSelect={(id) => {
                    setSelectedFolder(id);
                    clearResults();
                  }}
                  loading={loadingModels}
                  disabled={initBusy || runBusy}
                  emptyMessage="No OCR models found. Use bundled assets, PAD, or Download Manager → OCR."
                />
                {selectedFolder && isGranitePack(selectedFolder) ? (
                  <DocVlmInitOptionChips
                    maxNewTokens={customInitForm.maxNewTokens}
                    onChangeMaxNewTokens={(maxNewTokens) =>
                      setCustomInitForm((prev) => ({ ...prev, maxNewTokens }))
                    }
                    disabled={initBusy || runBusy}
                  />
                ) : null}
              </>
            ) : (
              <OcrCustomInitForm
                value={customInitForm}
                onChange={setCustomInitForm}
                selectedCatalogModelId={selectedFolder}
                onFillFromSelectedModel={() => {
                  handleFillFromSelectedModel().catch(() => {});
                }}
                onPrepareScatteredTest={() => {
                  setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
                  setFillHint(
                    'Scattered test: pick required slots manually, then Initialize.'
                  );
                }}
                fillLoading={fillLoading}
                disabled={initBusy || runBusy}
                fillHint={
                  fillHint ??
                  (selectedFolder
                    ? `Fill can use last catalog selection: ${getModelDisplayName(
                        selectedFolder
                      )}`
                    : 'Pick files per slot, or switch to Auto, select a pack, then return here and Fill.')
                }
              />
            )}

            <Text style={styles.fieldLabel}>numThreads</Text>
            <View style={styles.fieldControlRow}>
              <TouchableOpacity
                style={[
                  styles.paramStepButton,
                  (initBusy || runBusy || numThreads <= MIN_THREADS) &&
                    styles.paramStepButtonDisabled,
                ]}
                onPress={() =>
                  setNumThreads((v) => Math.max(MIN_THREADS, v - 1))
                }
                disabled={initBusy || runBusy || numThreads <= MIN_THREADS}
              >
                <Text style={styles.paramStepButtonText}>-</Text>
              </TouchableOpacity>
              <View style={styles.paramValueBadge}>
                <Text style={styles.paramValueText}>{numThreads}</Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.paramStepButton,
                  (initBusy || runBusy || numThreads >= MAX_THREADS) &&
                    styles.paramStepButtonDisabled,
                ]}
                onPress={() =>
                  setNumThreads((v) => Math.min(MAX_THREADS, v + 1))
                }
                disabled={initBusy || runBusy || numThreads >= MAX_THREADS}
              >
                <Text style={styles.paramStepButtonText}>+</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>provider</Text>
            <TouchableOpacity
              style={[
                styles.providerSelect,
                (initBusy || runBusy || providersLoading) &&
                  styles.providerSelectDisabled,
              ]}
              onPress={() => setProviderPickerOpen(true)}
              disabled={initBusy || runBusy || providersLoading}
            >
              <Text style={styles.providerSelectValue}>
                {providersLoading ? 'Detecting…' : provider}
              </Text>
              <Text style={styles.providerSelectHint}>
                {providersLoading
                  ? 'probing device'
                  : `${providerOptions.length} available ▾`}
              </Text>
            </TouchableOpacity>

            <View style={styles.sliderHeader}>
              <Text style={styles.fieldLabel}>detUnclipRatio</Text>
              <Text style={styles.sliderValue}>
                {detUnclipRatio.toFixed(2)}
              </Text>
            </View>
            <Text style={styles.sectionHint}>
              Expands DB detection boxes for ppocr/doctr (1.0 tight … 2.5
              loose). Default 1.5 — not glyph-perfect bounds. Re-init to apply.
            </Text>
            <View
              style={[
                styles.sliderTrack,
                unclipSliderDisabled && styles.sliderTrackDisabled,
              ]}
              onLayout={onUnclipSliderLayout}
              onStartShouldSetResponder={() => !unclipSliderDisabled}
              onMoveShouldSetResponder={() => !unclipSliderDisabled}
              onResponderTerminationRequest={() => false}
              onResponderGrant={onUnclipTouch}
              onResponderMove={onUnclipTouch}
            >
              <View style={styles.sliderRail} pointerEvents="none">
                <View
                  style={[
                    styles.sliderFill,
                    {
                      width: `${
                        ((detUnclipRatio - MIN_UNCLIP) /
                          (MAX_UNCLIP - MIN_UNCLIP)) *
                        100
                      }%`,
                    },
                  ]}
                />
              </View>
              <View
                pointerEvents="none"
                style={[
                  styles.sliderThumb,
                  {
                    left: `${
                      ((detUnclipRatio - MIN_UNCLIP) /
                        (MAX_UNCLIP - MIN_UNCLIP)) *
                      100
                    }%`,
                  },
                ]}
              />
            </View>
            <View style={styles.sliderLegend}>
              <Text style={styles.sliderLegendText}>
                {MIN_UNCLIP.toFixed(1)}
              </Text>
              <Text style={styles.sliderLegendText}>
                {MAX_UNCLIP.toFixed(1)}
              </Text>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.actionButtonFlex,
                  (initBusy ||
                    runBusy ||
                    (initMode === 'auto' && !selectedFolder)) &&
                    styles.primaryButtonDisabled,
                ]}
                onPress={() => {
                  handleInit().catch(() => {});
                }}
                disabled={
                  initBusy ||
                  runBusy ||
                  (initMode === 'auto' && !selectedFolder)
                }
              >
                {initBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    {initializedFolder ? 'Re-initialize' : 'Initialize'}
                  </Text>
                )}
              </TouchableOpacity>
              {initializedFolder ? (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.actionButtonFlex]}
                  onPress={() => {
                    destroyEngine().catch(() => {});
                  }}
                  disabled={initBusy || runBusy}
                >
                  <Text style={styles.secondaryButtonText}>Destroy</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {initMessage || detectSummary ? (
              <View style={styles.statusCard}>
                {initMessage ? (
                  <View style={styles.statusBlock}>
                    <Text style={styles.statusLabel}>Engine</Text>
                    <Text style={styles.mono}>{initMessage}</Text>
                  </View>
                ) : null}
                {detectSummary ? (
                  <View style={styles.statusBlock}>
                    <Text style={styles.statusLabel}>Detect</Text>
                    <Text style={styles.mono}>{detectSummary}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

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
            {progressLabel ? (
              <View style={styles.progressBox}>
                <Text style={styles.progressLabel}>{progressLabel}</Text>
                {progressPercent != null ? (
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${progressPercent}%` },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
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
                {resultMeta?.family === 'doc_vlm'
                  ? `\ncomplete=${resultMeta.complete}\nstopReason=${resultMeta.stopReason}`
                  : ''}
                {lastMs != null ? `\nwall=${lastMs}ms` : ''}
                {imageInfo
                  ? `\nframe=${imageInfo.width}×${imageInfo.height}`
                  : ''}
              </Text>
              {resultMeta?.family === 'doc_vlm' && !resultMeta.complete ? (
                <Text style={styles.sectionHint}>
                  Incomplete DocTags ({resultMeta.stopReason}). Raw output is
                  still on the DocTags tab.
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
                {overlayEnabled && resultTextBufferId ? (
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
                    onSpanPress={(event) =>
                      setSelectedSpanIndex(
                        selectedSpanIndex === event.index ? null : event.index
                      )
                    }
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
                    Tap a box to highlight that span in the text below. Blue =
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

            {showDocVlmTabs ? (
              <View style={styles.tabRow}>
                {(
                  [
                    ['text', 'Plain'],
                    ['markdown', 'Markdown'],
                    ['doctags', 'DocTags'],
                  ] as const
                ).map(([id, label]) => (
                  <TouchableOpacity
                    key={id}
                    style={[styles.tab, resultTab === id && styles.tabActive]}
                    onPress={() => setResultTab(id)}
                  >
                    <Text
                      style={[
                        styles.tabText,
                        resultTab === id && styles.tabTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <View style={styles.card}>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>
                  {textShowAllPages
                    ? 'Text · all pages'
                    : `Text · page ${resultFrameIndex + 1}`}
                </Text>
                {multiPage ? (
                  <View style={styles.toggleTrailing}>
                    <Text style={styles.sectionHint}>All pages</Text>
                    <Switch
                      value={textShowAllPages}
                      onValueChange={(on) => {
                        setTextShowAllPages(on);
                        if (!on) {
                          setResultTab('text');
                        }
                      }}
                    />
                  </View>
                ) : null}
              </View>
              {textShowAllPages && resultTab === 'markdown' && docVlmExtras ? (
                <Text style={styles.resultText}>
                  {docVlmExtras.markdown || '(empty markdown)'}
                </Text>
              ) : textShowAllPages &&
                resultTab === 'doctags' &&
                docVlmExtras ? (
                <Text style={styles.resultText}>
                  {docVlmExtras.doctags || '(empty doctags)'}
                </Text>
              ) : (
                <HighlightedResultText
                  fullText={resultText}
                  spans={spans}
                  selectedIndex={selectedSpanIndex}
                  pageOnly={!textShowAllPages}
                  frameIndex={resultFrameIndex}
                />
              )}
              <TouchableOpacity
                style={[styles.primaryButton, { marginTop: 12 }]}
                onPress={() => {
                  const payload =
                    textShowAllPages && resultTab === 'markdown' && docVlmExtras
                      ? docVlmExtras.markdown
                      : textShowAllPages &&
                        resultTab === 'doctags' &&
                        docVlmExtras
                      ? docVlmExtras.doctags
                      : scopedText;
                  Clipboard.setString(payload);
                }}
              >
                <Text style={styles.primaryButtonText}>Copy</Text>
              </TouchableOpacity>
            </View>

            {spans.length > 0 ? (
              <View style={styles.card}>
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>
                    Spans ({scopedSpans.length}
                    {spansShowAllPages
                      ? ` · ${spans.length} total`
                      : ` · page ${resultFrameIndex + 1}`}
                    )
                  </Text>
                  {multiPage ? (
                    <View style={styles.toggleTrailing}>
                      <Text style={styles.sectionHint}>All pages</Text>
                      <Switch
                        value={spansShowAllPages}
                        onValueChange={setSpansShowAllPages}
                      />
                    </View>
                  ) : null}
                </View>
                {scopedSpans.map((span) => {
                  const index = spans.indexOf(span);
                  const active = selectedSpanIndex === index;
                  const slice = utf16Slice(
                    resultText,
                    span.utf16Start,
                    span.utf16End
                  );
                  return (
                    <TouchableOpacity
                      key={`list-${index}`}
                      style={[styles.spanRow, active && styles.spanRowActive]}
                      onPress={() => {
                        setSelectedSpanIndex(active ? null : index);
                        setResultFrameIndex(span.frameIndex);
                      }}
                    >
                      <Text style={styles.resultText} numberOfLines={2}>
                        {slice || '(empty slice)'}
                      </Text>
                      <Text style={styles.spanMeta}>
                        #{index} frame {span.frameIndex + 1} {span.level} conf=
                        {(span.confidence ?? 0).toFixed(2)} utf16=
                        {span.utf16Start}-{span.utf16End} quad=
                        {span.quad.map((n) => Math.round(n)).join(',')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <Modal
        visible={providerPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProviderPickerOpen(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setProviderPickerOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>Execution provider</Text>
            <Text style={styles.sectionHint}>
              Only providers compiled into this ORT build that also pass a
              device canInit probe.
            </Text>
            <ScrollView>
              {providerOptions.map((option) => {
                const active = option === provider;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.modalItem, active && styles.modalItemActive]}
                    onPress={() => {
                      setProvider(option);
                      setProviderPickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.modalItemText,
                        active && styles.modalItemTextActive,
                      ]}
                    >
                      {option}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
