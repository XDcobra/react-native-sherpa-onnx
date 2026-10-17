import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  listDownloadedModels,
  onModelsListUpdated,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import {
  createOCR,
  detectOcrModel,
  isOcrDocVlmDetectSuccess,
  isOcrDoctrDetectSuccess,
  isOcrPpocrDetectSuccess,
  type OcrEngine,
  type OcrInitializeOptions,
  type OcrModelType,
  type OcrProgress,
  type OcrRecognizeResult,
} from 'react-native-sherpa-onnx/ocr';
import {
  createEmptyOfflineTextBuffer,
  getOfflineTextBufferSpatialSpansSlice,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  type OfflineTextBufferInfo,
  type TextSpatialSpan,
} from 'react-native-sherpa-onnx/textbuffer';
import { InitModeSelector, ModelFolderGrid } from '../../components/modelInit';
import type { ModelInitMode } from '../../components/modelInit';
import {
  OfflineImageBufferWidget,
  type OfflineImageBufferInfo,
  type OfflineImageBufferWidgetHandle,
} from '../../components/OfflineImageBufferWidget';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { IMAGE_FILES } from '../../imageConfig';
import { getFileModelPath, getModelDisplayName } from '../../modelConfig';
import { OcrQuadOverlay } from './OcrQuadOverlay';
import { styles } from './OCRScreen.styles';

const MODEL_TYPES: OcrModelType[] = ['auto', 'ppocr', 'doctr', 'doc_vlm'];

function isGranitePack(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('docvlm') || lower.includes('granite');
}

function utf16Slice(text: string, start: number, end: number): string {
  // TextBuffer offsets are UTF-16 code units; string.slice matches for BMP text.
  return text.slice(start, end);
}

export default function OCRScreen() {
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [initializedFolder, setInitializedFolder] = useState<string | null>(
    null
  );
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [modelType, setModelType] = useState<OcrModelType>('auto');
  const [numThreads, setNumThreads] = useState('2');
  const [provider, setProvider] = useState('cpu');
  const [initBusy, setInitBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initMessage, setInitMessage] = useState<string | null>(null);
  const [detectSummary, setDetectSummary] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<OfflineImageBufferInfo | null>(
    null
  );
  const [resultText, setResultText] = useState('');
  const [resultMeta, setResultMeta] = useState<OcrRecognizeResult | null>(null);
  const [spans, setSpans] = useState<TextSpatialSpan[]>([]);
  const [selectedSpanIndex, setSelectedSpanIndex] = useState<number | null>(
    null
  );
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [resultTab, setResultTab] = useState<'text' | 'markdown' | 'doctags'>(
    'text'
  );
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);

  const engineRef = useRef<OcrEngine | null>(null);
  const imageWidgetRef = useRef<OfflineImageBufferWidgetHandle>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const downloaded = await listDownloadedModels(ModelCategory.Ocr);
      const ids = downloaded.map((m) => m.id);
      setDownloadedModelIds(ids);
      setSelectedFolder((prev) => {
        if (prev && ids.includes(prev)) return prev;
        const tiny = ids.find((id) =>
          id.toLowerCase().includes('ppocrv6-tiny')
        );
        return tiny ?? ids[0] ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    refreshModels().catch(() => {});
    return onModelsListUpdated((category) => {
      if (category === ModelCategory.Ocr) {
        refreshModels().catch(() => {});
      }
    });
  }, [refreshModels]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      const engine = engineRef.current;
      engineRef.current = null;
      engine?.destroy().catch(() => {});
    };
  }, []);

  const modelEntries = useMemo(
    () =>
      downloadedModelIds.map((id) => ({
        id,
        label: getModelDisplayName(id),
        recommended: id.toLowerCase().includes('ppocrv6-tiny'),
      })),
    [downloadedModelIds]
  );

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

  const runDetect = useCallback(async (folder: string) => {
    const modelSource = getFileModelPath(folder, ModelCategory.Ocr);
    const det = await detectOcrModel(modelSource, { modelType: 'auto' });
    const guard =
      (isOcrPpocrDetectSuccess(det) && 'ppocr paths OK') ||
      (isOcrDoctrDetectSuccess(det) && 'doctr paths OK') ||
      (isOcrDocVlmDetectSuccess(det) && 'doc_vlm paths OK') ||
      'paths incomplete / failed';
    setDetectSummary(
      det.success
        ? `detect: modelType=${det.modelType ?? '?'} · ${guard}`
        : `detect failed: ${det.error ?? 'unknown'}`
    );
    return det;
  }, []);

  const handleInit = useCallback(async () => {
    if (!selectedFolder) {
      setError('Select a downloaded OCR pack (Download Manager → OCR).');
      return;
    }

    const proceed = async () => {
      setInitBusy(true);
      setError(null);
      setInitMessage(null);
      try {
        await destroyEngine();
        const modelSource = getFileModelPath(selectedFolder, ModelCategory.Ocr);
        await runDetect(selectedFolder);

        const threads = Math.max(1, parseInt(numThreads, 10) || 2);
        const resolvedType: OcrModelType =
          initMode === 'auto' ? 'auto' : modelType;
        const wantDocVlmOpts =
          resolvedType === 'doc_vlm' ||
          resolvedType === 'auto' ||
          selectedFolder.toLowerCase().includes('docvlm');
        const initOptions: OcrInitializeOptions =
          resolvedType === 'ppocr'
            ? {
                modelSource,
                modelType: 'ppocr',
                provider: provider.trim() || 'cpu',
                numThreads: threads,
              }
            : resolvedType === 'doctr'
            ? {
                modelSource,
                modelType: 'doctr',
                provider: provider.trim() || 'cpu',
                numThreads: threads,
              }
            : resolvedType === 'doc_vlm'
            ? {
                modelSource,
                modelType: 'doc_vlm',
                provider: provider.trim() || 'cpu',
                numThreads: threads,
                docVlm: { maxNewTokens: 512 },
              }
            : {
                modelSource,
                modelType: 'auto',
                provider: provider.trim() || 'cpu',
                numThreads: threads,
                ...(wantDocVlmOpts ? { docVlm: { maxNewTokens: 512 } } : {}),
              };
        const ocr = await createOCR(initOptions);
        engineRef.current = ocr;
        setInitializedFolder(selectedFolder);
        setInitMessage(
          `Ready · instance=${ocr.instanceId} · modelType=${
            initMode === 'auto' ? 'auto' : modelType
          }`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInitBusy(false);
      }
    };

    if (isGranitePack(selectedFolder)) {
      Alert.alert(
        'Large Doc-VLM pack',
        'docvlm-granite-258m is ~420 MiB compressed / ~1.2 GiB unpacked and needs significant RAM. Mobile ORT must include com.microsoft.GroupQueryAttention. Continue?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Initialize',
            onPress: () => {
              proceed().catch(() => {});
            },
          },
        ]
      );
      return;
    }

    await proceed();
  }, [
    destroyEngine,
    initMode,
    modelType,
    numThreads,
    provider,
    runDetect,
    selectedFolder,
  ]);

  const clearResults = useCallback(() => {
    setResultText('');
    setResultMeta(null);
    setSpans([]);
    setSelectedSpanIndex(null);
    setLastMs(null);
    setProgressLabel(null);
    setProgressPercent(null);
    setResultTab('text');
  }, []);

  const handleRecognize = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !imageInfo) {
      setError('Initialize OCR and load an image first.');
      return;
    }

    setRunBusy(true);
    setError(null);
    clearResults();
    const controller = new AbortController();
    abortRef.current = controller;
    const t0 = Date.now();

    let textOutId: string | null = null;
    try {
      const textOut = await createEmptyOfflineTextBuffer();
      textOutId = textOut.bufferId;

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
      setSpans(spatial);
      setLastMs(Date.now() - t0);
      if (page.family === 'doc_vlm' && page.markdown.trim().length > 0) {
        setResultTab('markdown');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CANCELLED') || msg.includes('cancelled')) {
        setError('Recognize cancelled (OCR_CANCELLED).');
      } else {
        setError(msg);
      }
    } finally {
      if (textOutId) {
        await releasePipelineTextBuffer(textOutId).catch(() => {});
      }
      abortRef.current = null;
      setRunBusy(false);
      setProgressLabel(null);
      setProgressPercent(null);
    }
  }, [clearResults, imageInfo]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const selectedSpanText =
    selectedSpanIndex != null && spans[selectedSpanIndex]
      ? utf16Slice(
          resultText,
          spans[selectedSpanIndex]!.utf16Start,
          spans[selectedSpanIndex]!.utf16End
        )
      : null;

  const showDocVlmTabs =
    resultMeta?.family === 'doc_vlm' &&
    (resultMeta.markdown.length > 0 || resultMeta.doctags.length > 0);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="OCR" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>1. OCR model</Text>
        <Text style={styles.sectionHint}>
          Download packs in Download Manager (category OCR). Recommended demo
          start: ppocrv6-tiny. Recreate the engine when switching families.
        </Text>

        <ModelFolderGrid
          entries={modelEntries}
          selectedId={selectedFolder}
          initializedId={initializedFolder}
          onSelect={(id) => {
            setSelectedFolder(id);
            clearResults();
          }}
          loading={loadingModels}
          disabled={initBusy || runBusy}
          emptyMessage="No OCR packs downloaded yet. Open Download Manager → OCR."
        />

        <InitModeSelector
          value={initMode}
          onChange={setInitMode}
          disabled={initBusy || runBusy}
        />

        {initMode === 'custom' ? (
          <View>
            <Text style={styles.fieldLabel}>modelType</Text>
            <View style={styles.chipRow}>
              {MODEL_TYPES.filter((t) => t !== 'auto').map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.chip, modelType === t && styles.chipActive]}
                  onPress={() => setModelType(t)}
                  disabled={initBusy || runBusy}
                >
                  <Text
                    style={[
                      styles.chipText,
                      modelType === t && styles.chipTextActive,
                    ]}
                  >
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : (
          <Text style={styles.sectionHint}>
            Init uses modelType=auto (manifest / layout detect).
          </Text>
        )}

        <Text style={styles.fieldLabel}>numThreads</Text>
        <TextInput
          style={styles.fieldInput}
          value={numThreads}
          onChangeText={setNumThreads}
          keyboardType="number-pad"
          editable={!initBusy && !runBusy}
        />
        <Text style={styles.fieldLabel}>provider</Text>
        <TextInput
          style={styles.fieldInput}
          value={provider}
          onChangeText={setProvider}
          autoCapitalize="none"
          editable={!initBusy && !runBusy}
        />

        <TouchableOpacity
          style={[
            styles.primaryButton,
            (initBusy || !selectedFolder) && styles.primaryButtonDisabled,
          ]}
          onPress={() => {
            handleInit().catch(() => {});
          }}
          disabled={initBusy || !selectedFolder || runBusy}
        >
          {initBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {initializedFolder ? 'Re-initialize OCR' : 'Initialize OCR'}
            </Text>
          )}
        </TouchableOpacity>

        {initializedFolder ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => {
              destroyEngine().catch(() => {});
            }}
            disabled={initBusy || runBusy}
          >
            <Text style={styles.secondaryButtonText}>Destroy engine</Text>
          </TouchableOpacity>
        ) : null}

        {initMessage ? (
          <View style={styles.card}>
            <Text style={styles.mono}>{initMessage}</Text>
          </View>
        ) : null}
        {detectSummary ? (
          <View style={styles.card}>
            <Text style={styles.mono}>{detectSummary}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>2. Image buffer</Text>
        <Text style={styles.sectionHint}>
          Bundled test_images/ or pick your own. Creates an OfflineImageBuffer
          (native RGB8) for recognize.
        </Text>
        <OfflineImageBufferWidget
          ref={imageWidgetRef}
          imageFiles={IMAGE_FILES}
          visible={!!initializedFolder}
          disabled={runBusy || initBusy}
          onBufferReady={(info) => {
            setImageInfo(info);
            clearResults();
          }}
          onBufferReleased={() => {
            setImageInfo(null);
            clearResults();
          }}
        />
        {!initializedFolder ? (
          <Text style={styles.sectionHint}>
            Initialize an OCR engine to enable the image picker.
          </Text>
        ) : null}

        <Text style={styles.sectionTitle}>3. Recognize</Text>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            (!initializedFolder || !imageInfo || runBusy) &&
              styles.primaryButtonDisabled,
          ]}
          onPress={() => {
            handleRecognize().catch(() => {});
          }}
          disabled={!initializedFolder || !imageInfo || runBusy}
        >
          {runBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>Run OCR</Text>
          )}
        </TouchableOpacity>
        {runBusy ? (
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleCancel}
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
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

        {resultMeta ? (
          <View>
            <Text style={styles.sectionTitle}>4. Results</Text>
            <View style={styles.card}>
              <Text style={styles.mono}>
                family={resultMeta.family}
                {'\n'}
                spanCount={resultMeta.spanCount}
                {lastMs != null ? `\nwall=${lastMs}ms` : ''}
                {'\n'}
                frame={imageInfo?.width}×{imageInfo?.height}
              </Text>
            </View>

            {imageInfo?.previewUri ? (
              <View>
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>
                    Spatial overlay (span.quad)
                  </Text>
                  <Switch
                    value={overlayEnabled}
                    onValueChange={setOverlayEnabled}
                  />
                </View>
                <OcrQuadOverlay
                  previewUri={imageInfo.previewUri}
                  frameWidth={imageInfo.width}
                  frameHeight={imageInfo.height}
                  spans={spans}
                  selectedIndex={selectedSpanIndex}
                  onSelectIndex={setSelectedSpanIndex}
                  overlayEnabled={overlayEnabled}
                />
                <Text style={[styles.sectionHint, { marginTop: 8 }]}>
                  Boxes are axis-aligned bounds of each quad in decoded-frame
                  pixels. Tap a box to highlight the text slice.
                </Text>
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
              <Text style={styles.resultText}>
                {resultTab === 'markdown'
                  ? resultMeta.markdown || '(empty markdown)'
                  : resultTab === 'doctags'
                  ? resultMeta.doctags || '(empty doctags)'
                  : resultText || '(empty text)'}
              </Text>
              {selectedSpanText != null ? (
                <Text style={[styles.mono, { marginTop: 10 }]}>
                  selected span: {JSON.stringify(selectedSpanText)}
                </Text>
              ) : null}
              <TouchableOpacity
                style={[styles.primaryButton, { marginTop: 12 }]}
                onPress={() => {
                  const payload =
                    resultTab === 'markdown'
                      ? resultMeta.markdown
                      : resultTab === 'doctags'
                      ? resultMeta.doctags
                      : resultText;
                  Clipboard.setString(payload);
                }}
              >
                <Text style={styles.primaryButtonText}>Copy</Text>
              </TouchableOpacity>
            </View>

            {spans.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.toggleLabel}>Spans ({spans.length})</Text>
                {spans.map((span, index) => {
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
                      onPress={() =>
                        setSelectedSpanIndex(active ? null : index)
                      }
                    >
                      <Text style={styles.resultText} numberOfLines={2}>
                        {slice || '(empty slice)'}
                      </Text>
                      <Text style={styles.spanMeta}>
                        #{index} {span.level} conf=
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
    </SafeAreaView>
  );
}
