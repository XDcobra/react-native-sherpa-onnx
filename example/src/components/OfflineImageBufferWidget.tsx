/**
 * OfflineImageBufferWidget
 *
 * Shared component: bundled example images or DocumentPicker → OfflineImageBuffer.
 * Mirrors OfflineAudioBufferWidget for OCR / vision screens.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createOfflineImageBufferFromFiles,
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { rasterizePdfPages } from 'react-native-sherpa-onnx/pdf';
import type { ImageFileInfo } from '../imageConfig';
import type { PdfFileInfo } from '../pdfConfig';
import {
  fileSourceFromBundledPath,
  toFileSource as toFileSourceWithHint,
} from '../utils/fileSourceFromUri';
import { resolveImageDisplayUri } from '../utils/imageDisplayUri';
import { OfflineImageBufferFramePager } from './OfflineImageBufferFramePager';
import { widgetStyles as s } from './OfflineImageBufferWidget.styles';

/** Bundled fixture row for image or PDF pickers. */
export type ExampleBundledFileInfo = {
  id: string;
  name: string;
  description: string;
  section?: string;
  kind?: 'image' | 'pdf';
  /** Multi-frame image: asset paths decoded as separate OfflineImageBuffer frames. */
  framePaths?: string[];
};

export type OfflineImageBufferInfo = {
  bufferId: string;
  sourceLabel: string;
  /** URI for legacy overlays; FrameView preview does not require it. */
  previewUri: string | null;
  width: number;
  height: number;
  frameCount: number;
  kind?: 'image' | 'pdf';
  /** PDF raster strategy used when kind === 'pdf'. */
  state?: 'immutable' | 'lazy';
};

export type PdfSourceSelection = {
  label: string;
  source: FileSource;
  /** Bundled fixture id when picked from examples. */
  fixtureId?: string;
};

export type OfflineImageBufferWidgetHandle = {
  clear: () => Promise<void>;
};

type Props = {
  imageFiles: ImageFileInfo[];
  /** Optional PDF fixtures listed alongside images. */
  pdfFiles?: PdfFileInfo[];
  onBufferReady: (info: OfflineImageBufferInfo) => void;
  onBufferReleased: () => void;
  /** PDF selected (bundled or document picker) — parent runs extract/raster. */
  onPdfSelected?: (selection: PdfSourceSelection) => void;
  onPdfCleared?: () => void;
  disabled?: boolean;
  visible?: boolean;
  externalError?: string | null;
  /** Longest edge for decode (default 2048). */
  maxSide?: number;
};

const IMAGE_PICKER_TYPES = [
  DocumentPicker.types.images,
  'public.png',
  'public.jpeg',
  'public.heic',
  'public.heif',
  'image/webp',
  'image/bmp',
  'image/gif',
] as const;

const FILE_PICKER_TYPES = [
  ...IMAGE_PICKER_TYPES,
  DocumentPicker.types.pdf,
  'com.adobe.pdf',
  'application/pdf',
] as const;

function looksLikePdf(nameOrUri: string, mime?: string | null): boolean {
  const mimeLower = (mime ?? '').toLowerCase();
  if (mimeLower.includes('pdf')) return true;
  const lower = nameOrUri.toLowerCase();
  return lower.endsWith('.pdf') || lower.includes('.pdf?');
}

function toImageFileSource(
  pathOrUri: string,
  displayName?: string
): FileSource {
  const trimmed = pathOrUri.trim();
  if (
    !trimmed.startsWith('content://') &&
    !trimmed.startsWith('file://') &&
    !trimmed.startsWith('/')
  ) {
    return fileSourceFromBundledPath(trimmed);
  }
  return toFileSourceWithHint(trimmed, displayName);
}

function isPickerCancel(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; name?: string; message?: string };
  const maybeIsCancel = (
    DocumentPicker as unknown as {
      isCancel?: (x: unknown) => boolean;
    }
  ).isCancel;
  return (
    (typeof maybeIsCancel === 'function' && maybeIsCancel(err)) ||
    e?.code === 'DOCUMENT_PICKER_CANCELED' ||
    e?.name === 'DocumentPickerCanceled' ||
    (typeof e?.message === 'string' &&
      e.message.toLowerCase().includes('cancel'))
  );
}

export function ExampleImageFileList({
  imageFiles,
  selectedId = null,
  onSelect,
  disabled = false,
}: {
  imageFiles: ExampleBundledFileInfo[];
  selectedId?: string | null;
  onSelect: (file: ExampleBundledFileInfo) => void;
  disabled?: boolean;
}) {
  const sections = useMemo(() => {
    const hasSections = imageFiles.some((file) => !!file.section);
    if (!hasSections) {
      return [{ title: null as string | null, files: imageFiles }];
    }
    const groups: { title: string | null; files: ExampleBundledFileInfo[] }[] =
      [];
    for (const file of imageFiles) {
      const title = file.section ?? null;
      const last = groups[groups.length - 1];
      if (last && last.title === title) {
        last.files.push(file);
      } else {
        groups.push({ title, files: [file] });
      }
    }
    return groups;
  }, [imageFiles]);

  if (imageFiles.length === 0) {
    return (
      <Text style={{ color: '#666', marginBottom: 8 }}>
        No example files available.
      </Text>
    );
  }

  return (
    <View style={s.imageFilesContainer}>
      {sections.map((section, sectionIndex) => (
        <View
          key={section.title ?? `section-${sectionIndex}`}
          style={s.imageFileSection}
        >
          {section.title ? (
            <Text style={s.imageFileSectionTitle}>{section.title}</Text>
          ) : null}
          {section.files.map((imageFile) => {
            const isSelected =
              selectedId != null && selectedId === imageFile.id;
            return (
              <TouchableOpacity
                key={imageFile.id}
                style={[
                  s.imageFileButton,
                  isSelected && s.imageFileButtonActive,
                  disabled && s.buttonDisabled,
                ]}
                onPress={() => onSelect(imageFile)}
                disabled={disabled}
              >
                <Text
                  style={[
                    s.imageFileButtonText,
                    isSelected && s.imageFileButtonTextActive,
                  ]}
                >
                  {imageFile.name}
                </Text>
                <Text style={s.imageFileDescription}>
                  {imageFile.description}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export const OfflineImageBufferWidget = forwardRef<
  OfflineImageBufferWidgetHandle,
  Props
>(function OfflineImageBufferWidget(
  {
    imageFiles,
    pdfFiles = [],
    onBufferReady,
    onBufferReleased,
    onPdfSelected,
    onPdfCleared,
    disabled = false,
    visible = true,
    externalError = null,
    maxSide = 2048,
  },
  ref
) {
  const [sourceType, setSourceType] = useState<'example' | 'own' | null>(null);
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    null
  );
  const [pdfActiveLabel, setPdfActiveLabel] = useState<string | null>(null);

  const exampleFiles = useMemo((): ExampleBundledFileInfo[] => {
    const images: ExampleBundledFileInfo[] = imageFiles.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      kind: 'image' as const,
      section: f.section ? `Images — ${f.section}` : 'Images',
      framePaths: f.framePaths,
    }));
    const pdfs: ExampleBundledFileInfo[] = pdfFiles.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      kind: 'pdf' as const,
      section: f.section ? `PDFs — ${f.section}` : 'PDFs',
    }));
    return [...images, ...pdfs];
  }, [imageFiles, pdfFiles]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bufferInfo, setBufferInfo] = useState<OfflineImageBufferInfo | null>(
    null
  );
  const bufferIdRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    return () => {
      requestRef.current += 1;
      const id = bufferIdRef.current;
      bufferIdRef.current = null;
      if (id) {
        releaseOfflineImageBuffer(id).catch(() => {});
      }
    };
  }, []);

  const releaseBuffer = useCallback(async () => {
    const id = bufferIdRef.current;
    bufferIdRef.current = null;
    setBufferInfo(null);
    if (id) {
      await releaseOfflineImageBuffer(id).catch(() => {});
    }
  }, []);

  const resetAll = useCallback(
    async (keepSourceChoice = false) => {
      requestRef.current += 1;
      setLoading(false);
      setLoadProgress(null);
      setLoadStatus(null);
      setLoadError(null);
      setSelectedExampleId(null);
      setPdfActiveLabel(null);
      await releaseBuffer();
      if (!keepSourceChoice) {
        setSourceType(null);
      }
    },
    [releaseBuffer]
  );

  useImperativeHandle(
    ref,
    () => ({
      clear: async () => {
        await resetAll(false);
        onBufferReleased();
        onPdfCleared?.();
      },
    }),
    [resetAll, onBufferReleased, onPdfCleared]
  );

  const loadSource = useCallback(
    async (label: string, sources: FileSource | FileSource[]) => {
      const requestId = ++requestRef.current;
      await releaseBuffer();

      const list = Array.isArray(sources) ? sources : [sources];
      setLoading(true);
      setLoadProgress(0);
      setLoadStatus(
        list.length > 1
          ? `Decoding "${label}" (${list.length} frames)…`
          : `Decoding "${label}" into OfflineImageBuffer…`
      );
      setLoadError(null);

      try {
        setPdfActiveLabel(null);
        const created = await createOfflineImageBufferFromFiles(list, {
          maxSide,
          onProgress: (event: { percent?: number; phase?: string }) => {
            if (requestId !== requestRef.current) return;
            const pct = Math.max(0, Math.min(100, event.percent ?? 0));
            setLoadProgress(pct);
            setLoadStatus(
              event.phase
                ? `Decoding "${label}"… ${event.phase} (${Math.round(pct)}%)`
                : `Decoding "${label}"… ${Math.round(pct)}%`
            );
          },
        });

        if (requestId !== requestRef.current) {
          await releaseOfflineImageBuffer(created.bufferId).catch(() => {});
          return;
        }

        const frame = await getOfflineImageBufferFrameInfo(created, 0);
        // Overlay URI only for single-file images; multi-frame uses FrameView alone.
        const previewUri =
          list.length === 1
            ? await resolveImageDisplayUri(list[0]!).catch(() => null)
            : null;

        bufferIdRef.current = created.bufferId;
        const info: OfflineImageBufferInfo = {
          bufferId: created.bufferId,
          sourceLabel: label,
          previewUri,
          width: frame.width,
          height: frame.height,
          frameCount: created.info.frameCount,
          kind: 'image',
          state: 'immutable',
        };
        setBufferInfo(info);
        setLoadProgress(null);
        setLoadStatus(null);
        onBufferReady(info);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoadProgress(null);
        setLoadStatus(null);
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
        }
      }
    },
    [maxSide, onBufferReady, releaseBuffer]
  );

  const clearPdfUi = useCallback(() => {
    setPdfActiveLabel(null);
    onPdfCleared?.();
  }, [onPdfCleared]);

  const selectPdf = useCallback(
    async (selection: PdfSourceSelection) => {
      const requestId = ++requestRef.current;
      await releaseBuffer();
      setBufferInfo(null);
      onBufferReleased();
      setPdfActiveLabel(selection.label);
      setLoadError(null);
      setLoading(true);
      setLoadProgress(0);
      setLoadStatus(`Rasterizing "${selection.label}" (lazy-lru)…`);

      try {
        // Always lazy-lru first; single-page UX is equivalent. Multi-page keeps
        // cold slots + LRUs hot frames for the slide viewer.
        const pages = await rasterizePdfPages(selection.source, {
          strategy: 'lazy-lru',
          dpi: 144,
          maxSide,
          onProgress: (p) => {
            if (requestId !== requestRef.current) return;
            const pct = p.total > 0 ? Math.round((100 * p.done) / p.total) : 0;
            setLoadProgress(pct);
            setLoadStatus(
              `Rasterizing "${selection.label}"… ${p.phase} (${p.done}/${p.total})`
            );
          },
        });

        if (requestId !== requestRef.current) {
          await releaseOfflineImageBuffer(pages.bufferId).catch(() => {});
          return;
        }

        const frame = await getOfflineImageBufferFrameInfo(pages, 0);
        bufferIdRef.current = pages.bufferId;
        const info: OfflineImageBufferInfo = {
          bufferId: pages.bufferId,
          sourceLabel: selection.label,
          previewUri: null,
          width: frame.width,
          height: frame.height,
          frameCount: pages.info.frameCount,
          kind: 'pdf',
          state: 'lazy',
        };
        setBufferInfo(info);
        setLoadProgress(null);
        setLoadStatus(null);
        onBufferReady(info);
        onPdfSelected?.(selection);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoadProgress(null);
        setLoadStatus(null);
        setPdfActiveLabel(null);
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
        }
      }
    },
    [maxSide, onBufferReady, onBufferReleased, onPdfSelected, releaseBuffer]
  );

  const handleExamplePick = useCallback(
    async (file: ExampleBundledFileInfo) => {
      setSelectedExampleId(file.id);
      if (file.kind === 'pdf') {
        await selectPdf({
          label: file.name,
          source: toImageFileSource(file.id),
          fixtureId: file.id,
        });
        return;
      }
      clearPdfUi();
      if (file.framePaths && file.framePaths.length > 0) {
        await loadSource(
          file.name,
          file.framePaths.map((path) => toImageFileSource(path))
        );
        return;
      }
      await loadSource(file.name, toImageFileSource(file.id));
    },
    [clearPdfUi, loadSource, selectPdf]
  );

  const handleOwnPick = useCallback(async () => {
    try {
      const [file] = await DocumentPicker.pick({
        type: onPdfSelected ? [...FILE_PICKER_TYPES] : [...IMAGE_PICKER_TYPES],
        allowMultiSelection: false,
      });
      if (!file?.uri) return;
      const label = file.name?.trim() || 'Picked file';
      const nameOrUri = file.name || file.uri;
      if (
        onPdfSelected &&
        looksLikePdf(nameOrUri, (file as { type?: string }).type)
      ) {
        setSelectedExampleId(null);
        await selectPdf({
          label,
          source: toImageFileSource(file.uri, file.name ?? undefined),
        });
        return;
      }
      clearPdfUi();
      await loadSource(
        label,
        toImageFileSource(file.uri, file.name ?? undefined)
      );
    } catch (err) {
      if (isPickerCancel(err)) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [clearPdfUi, loadSource, onPdfSelected, selectPdf]);

  if (!visible) {
    return null;
  }

  const busy = disabled || loading;
  const showError = loadError || externalError;

  return (
    <View style={s.root}>
      {bufferInfo == null && pdfActiveLabel == null && sourceType == null ? (
        <View style={s.sourceChoiceRow}>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => setSourceType('example')}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>
              {pdfFiles.length > 0 ? 'Example file' : 'Example Image'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => {
              setSourceType('own');
              handleOwnPick().catch(() => {});
            }}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>
              {onPdfSelected ? 'Own file' : 'Own Image'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {bufferInfo == null &&
      pdfActiveLabel == null &&
      sourceType === 'example' ? (
        <View style={s.root}>
          <View style={s.sourceActionRow}>
            <TouchableOpacity
              style={[s.backButton, busy && s.buttonDisabled]}
              onPress={() => {
                setSourceType(null);
                setSelectedExampleId(null);
              }}
              disabled={busy}
              accessibilityLabel="Back"
            >
              <Ionicons name="chevron-back" size={22} color="#007AFF" />
            </TouchableOpacity>
            <Text style={[s.subsectionTitle, s.sourceActionTitle]}>
              {pdfFiles.length > 0
                ? 'Choose an example image or PDF'
                : 'Choose an example image'}
            </Text>
          </View>
          <ExampleImageFileList
            imageFiles={exampleFiles}
            selectedId={selectedExampleId}
            onSelect={handleExamplePick}
            disabled={busy}
          />
        </View>
      ) : null}

      {bufferInfo == null &&
      pdfActiveLabel == null &&
      sourceType === 'own' &&
      !loading ? (
        <View style={s.sourceActionRow}>
          <TouchableOpacity
            style={[s.backButton, busy && s.buttonDisabled]}
            onPress={() => setSourceType(null)}
            disabled={busy}
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={22} color="#007AFF" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => {
              handleOwnPick().catch(() => {});
            }}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>
              {onPdfSelected ? 'Pick image or PDF…' : 'Pick image…'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={s.progressBox}>
          <Text style={s.progressLabel}>{loadStatus ?? 'Decoding image…'}</Text>
          {loadProgress != null ? (
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${loadProgress}%` }]} />
            </View>
          ) : (
            <ActivityIndicator color="#007AFF" />
          )}
        </View>
      ) : null}

      {showError ? <Text style={s.errorText}>{showError}</Text> : null}

      {bufferInfo ? (
        <View style={s.readyCard}>
          <View style={s.readyHeader}>
            <Text style={s.readyTitle} numberOfLines={2}>
              {bufferInfo.kind === 'pdf' ? 'PDF: ' : ''}
              {bufferInfo.sourceLabel}
            </Text>
            <TouchableOpacity
              style={s.deleteButton}
              onPress={async () => {
                const wasPdf = bufferInfo.kind === 'pdf';
                await resetAll(false);
                onBufferReleased();
                if (wasPdf) {
                  clearPdfUi();
                }
              }}
              disabled={busy}
            >
              <Ionicons name="trash-outline" size={22} color="#c00" />
            </TouchableOpacity>
          </View>
          <OfflineImageBufferFramePager
            buffer={bufferInfo.bufferId}
            frameCount={bufferInfo.frameCount}
            maxSide={Math.min(1280, maxSide)}
          />
          <Text style={s.metaText}>
            {bufferInfo.bufferId}
            {'\n'}
            {bufferInfo.width}×{bufferInfo.height} · frames{' '}
            {bufferInfo.frameCount}
            {bufferInfo.kind === 'pdf' && bufferInfo.frameCount > 1
              ? '\nlazy-lru preview · pager ensures pages on access'
              : bufferInfo.kind === 'pdf'
              ? '\nlazy-lru preview'
              : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
});
