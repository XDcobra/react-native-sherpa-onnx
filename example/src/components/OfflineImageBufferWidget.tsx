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
import {
  ActivityIndicator,
  Image,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createOfflineImageBufferFromFiles,
  getOfflineImageBufferFrameInfo,
  releaseOfflineImageBuffer,
} from 'react-native-sherpa-onnx/imagebuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import type { ImageFileInfo } from '../imageConfig';
import {
  fileSourceFromBundledPath,
  toFileSource as toFileSourceWithHint,
} from '../utils/fileSourceFromUri';
import { resolveImageDisplayUri } from '../utils/imageDisplayUri';
import { widgetStyles as s } from './OfflineImageBufferWidget.styles';

export type OfflineImageBufferInfo = {
  bufferId: string;
  sourceLabel: string;
  /** URI for `<Image>` preview (may be a cache copy of a bundled asset). */
  previewUri: string | null;
  width: number;
  height: number;
  frameCount: number;
};

export type OfflineImageBufferWidgetHandle = {
  clear: () => Promise<void>;
};

type Props = {
  imageFiles: ImageFileInfo[];
  onBufferReady: (info: OfflineImageBufferInfo) => void;
  onBufferReleased: () => void;
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
  imageFiles: ImageFileInfo[];
  selectedId?: string | null;
  onSelect: (file: ImageFileInfo) => void;
  disabled?: boolean;
}) {
  const sections = useMemo(() => {
    const hasSections = imageFiles.some((file) => !!file.section);
    if (!hasSections) {
      return [{ title: null as string | null, files: imageFiles }];
    }
    const groups: { title: string | null; files: ImageFileInfo[] }[] = [];
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
        No example images available.
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
    onBufferReady,
    onBufferReleased,
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
      },
    }),
    [resetAll, onBufferReleased]
  );

  const loadSource = useCallback(
    async (label: string, source: FileSource) => {
      const requestId = ++requestRef.current;
      await releaseBuffer();

      setLoading(true);
      setLoadProgress(0);
      setLoadStatus(`Decoding "${label}" into OfflineImageBuffer…`);
      setLoadError(null);

      try {
        const created = await createOfflineImageBufferFromFiles(source, {
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
        const previewUri = await resolveImageDisplayUri(source).catch(
          () => null
        );

        bufferIdRef.current = created.bufferId;
        const info: OfflineImageBufferInfo = {
          bufferId: created.bufferId,
          sourceLabel: label,
          previewUri,
          width: frame.width,
          height: frame.height,
          frameCount: created.info.frameCount,
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

  const handleExamplePick = useCallback(
    async (imageFile: ImageFileInfo) => {
      setSelectedExampleId(imageFile.id);
      await loadSource(imageFile.name, toImageFileSource(imageFile.id));
    },
    [loadSource]
  );

  const handleOwnPick = useCallback(async () => {
    try {
      const [file] = await DocumentPicker.pick({
        type: [...IMAGE_PICKER_TYPES],
        allowMultiSelection: false,
      });
      if (!file?.uri) return;
      const label = file.name?.trim() || 'Picked image';
      await loadSource(
        label,
        toImageFileSource(file.uri, file.name ?? undefined)
      );
    } catch (err) {
      if (isPickerCancel(err)) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [loadSource]);

  if (!visible) {
    return null;
  }

  const busy = disabled || loading;
  const showError = loadError || externalError;

  return (
    <View>
      {bufferInfo == null && sourceType == null ? (
        <View style={s.sourceChoiceRow}>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => setSourceType('example')}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>Example Image</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => {
              setSourceType('own');
              handleOwnPick().catch(() => {});
            }}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>Own Image</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {bufferInfo == null && sourceType === 'example' ? (
        <View>
          <Text style={s.subsectionTitle}>Choose an example image</Text>
          <ExampleImageFileList
            imageFiles={imageFiles}
            selectedId={selectedExampleId}
            onSelect={handleExamplePick}
            disabled={busy}
          />
          <TouchableOpacity
            style={s.changeSourceButton}
            onPress={() => {
              setSourceType(null);
              setSelectedExampleId(null);
            }}
            disabled={busy}
          >
            <Text style={s.changeSourceButtonText}>Change source</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {bufferInfo == null && sourceType === 'own' && !loading ? (
        <View>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => {
              handleOwnPick().catch(() => {});
            }}
            disabled={busy}
          >
            <Text style={s.sourceChoiceButtonText}>Pick image…</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.changeSourceButton}
            onPress={() => setSourceType(null)}
            disabled={busy}
          >
            <Text style={s.changeSourceButtonText}>Change source</Text>
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
              {bufferInfo.sourceLabel}
            </Text>
            <TouchableOpacity
              style={s.deleteButton}
              onPress={async () => {
                await resetAll(false);
                onBufferReleased();
              }}
              disabled={busy}
            >
              <Ionicons name="trash-outline" size={22} color="#c00" />
            </TouchableOpacity>
          </View>
          {bufferInfo.previewUri ? (
            <Image
              source={{ uri: bufferInfo.previewUri }}
              style={s.thumb}
              resizeMode="contain"
            />
          ) : null}
          <Text style={s.metaText}>
            {bufferInfo.bufferId}
            {'\n'}
            {bufferInfo.width}×{bufferInfo.height} · frames{' '}
            {bufferInfo.frameCount}
          </Text>
        </View>
      ) : null}
    </View>
  );
});
