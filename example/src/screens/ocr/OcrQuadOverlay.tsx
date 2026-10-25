import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import {
  getOfflineImageBufferFrameInfo,
  OfflineImageBufferFrameView,
  type OfflineImageBufferIdSource,
} from 'react-native-sherpa-onnx/imagebuffer';
import type { TextSpatialSpan } from 'react-native-sherpa-onnx/textbuffer';

type Props = {
  /** Preferred underlay: OfflineImageBuffer FrameView (OCR quad space). */
  buffer?: OfflineImageBufferIdSource | null;
  /** Frame count for prev/next when buffer has multiple pages/frames. */
  frameCount?: number;
  /** Fallback underlay when no buffer (legacy file preview). */
  previewUri?: string | null;
  /** Decoded frame size fallback (updated from buffer when available). */
  frameWidth: number;
  frameHeight: number;
  spans: TextSpatialSpan[];
  selectedIndex: number | null;
  onSelectIndex?: (index: number | null) => void;
  overlayEnabled: boolean;
  /**
   * When true, draw only OCR spans (decoded-frame pixels). textLayer quads are
   * PDF user-space and must not be painted on the raster FrameView.
   */
  overlayOcrSpansOnly?: boolean;
  /** Controlled page (Results). Uncontrolled fallback when omitted. */
  frameIndex?: number;
  onFrameIndexChange?: (index: number) => void;
};

function aabbFromQuad(quad: TextSpatialSpan['quad']): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function colorForLevel(
  level: TextSpatialSpan['level'],
  selected: boolean
): string {
  if (selected) return 'rgba(255, 59, 48, 0.55)';
  if (level === 'block') return 'rgba(52, 199, 89, 0.35)';
  if (level === 'word') return 'rgba(255, 149, 0, 0.35)';
  return 'rgba(0, 122, 255, 0.35)';
}

/**
 * Results underlay + axis-aligned boxes from span.quad (OCR decoded-frame pixels).
 * Prefers FrameView from OfflineImageBuffer; file URI is only a fallback.
 */
export function OcrQuadOverlay({
  buffer = null,
  frameCount = 1,
  previewUri = null,
  frameWidth,
  frameHeight,
  spans,
  selectedIndex,
  onSelectIndex,
  overlayEnabled,
  overlayOcrSpansOnly = true,
  frameIndex: frameIndexProp,
  onFrameIndexChange,
}: Props) {
  const total = Math.max(1, Math.trunc(frameCount));
  const controlled = typeof frameIndexProp === 'number';
  const [uncontrolledIndex, setUncontrolledIndex] = useState(0);
  const frameIndex = controlled
    ? Math.min(Math.max(0, Math.trunc(frameIndexProp)), total - 1)
    : uncontrolledIndex;
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({
    width: frameWidth,
    height: frameHeight,
  });

  const setFrameIndex = (next: number) => {
    const clamped = Math.min(Math.max(0, next), total - 1);
    if (controlled) {
      onFrameIndexChange?.(clamped);
      return;
    }
    setUncontrolledIndex(clamped);
  };

  useEffect(() => {
    if (controlled) return;
    setUncontrolledIndex((i) => Math.min(Math.max(0, i), total - 1));
  }, [controlled, total, buffer, previewUri]);

  useEffect(() => {
    setSize({ width: frameWidth, height: frameHeight });
  }, [frameWidth, frameHeight]);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    getOfflineImageBufferFrameInfo(buffer, frameIndex)
      .then((frame) => {
        if (cancelled) return;
        if (__DEV__) {
          console.log('[OcrQuadOverlay] frameInfo', {
            frameIndex,
            width: frame.width,
            height: frame.height,
            pageNumber: frame.pageNumber,
          });
        }
        setSize({ width: frame.width, height: frame.height });
      })
      .catch((err) => {
        if (__DEV__) {
          console.warn('[OcrQuadOverlay] frameInfo failed', frameIndex, err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, frameIndex]);

  const scale = useMemo(() => {
    if (
      layout.width <= 0 ||
      layout.height <= 0 ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return 1;
    }
    return Math.min(layout.width / size.width, layout.height / size.height);
  }, [layout, size.height, size.width]);

  const drawnW = size.width * scale;
  const drawnH = size.height * scale;
  const offsetX = (layout.width - drawnW) / 2;
  const offsetY = (layout.height - drawnH) / 2;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ width, height });
  };

  const visible = useMemo(() => {
    const rows = spans
      .map((span, index) => ({ span, index }))
      .filter(({ span }) => {
        if (span.frameIndex !== frameIndex) return false;
        if (overlayOcrSpansOnly && span.origin !== 'ocr') return false;
        return true;
      });
    if (__DEV__) {
      console.log('[OcrQuadOverlay] visibleSpans', {
        frameIndex,
        totalSpans: spans.length,
        visible: rows.length,
        origins: [...new Set(spans.map((s) => s.origin))],
        frameIndexes: [...new Set(spans.map((s) => s.frameIndex))],
      });
    }
    return rows;
  }, [frameIndex, overlayOcrSpansOnly, spans]);

  const hasUnderlay = Boolean(buffer) || Boolean(previewUri);
  if (!hasUnderlay) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          No image buffer for spatial overlay.
        </Text>
      </View>
    );
  }

  const showChrome = total > 1;
  const atStart = frameIndex <= 0;
  const atEnd = frameIndex >= total - 1;

  return (
    <View style={styles.root}>
      <View style={styles.wrap} onLayout={onLayout}>
        {/* Explicit size like FramePager — absoluteFill often leaves native FrameView blank. */}
        {buffer ? (
          <OfflineImageBufferFrameView
            buffer={buffer}
            frameIndex={frameIndex}
            maxSide={1280}
            resizeMode="contain"
            style={styles.frame}
          />
        ) : (
          <Image
            source={{ uri: previewUri! }}
            style={styles.frame}
            resizeMode="contain"
          />
        )}
        {overlayEnabled && layout.width > 0 ? (
          <View style={styles.boxLayer} pointerEvents="box-none">
            {visible.map(({ span, index }) => {
              const box = aabbFromQuad(span.quad);
              const selected = selectedIndex === index;
              return (
                <TouchableOpacity
                  key={`span-${index}`}
                  activeOpacity={0.8}
                  onPress={() => onSelectIndex?.(selected ? null : index)}
                  style={[
                    styles.box,
                    {
                      left: offsetX + box.left * scale,
                      top: offsetY + box.top * scale,
                      width: box.width * scale,
                      height: box.height * scale,
                      backgroundColor: colorForLevel(span.level, selected),
                      borderColor: selected ? '#FF3B30' : '#007AFF',
                    },
                  ]}
                />
              );
            })}
          </View>
        ) : null}
      </View>
      {overlayEnabled && visible.length > 0 ? (
        <Text style={styles.tapHint}>
          Tap a box to highlight that span in the text below.
        </Text>
      ) : null}
      {showChrome ? (
        <View style={styles.chrome}>
          <Text style={styles.pageLabel}>
            Page {frameIndex + 1} / {total}
            {overlayEnabled
              ? ` · ${visible.length} span${visible.length === 1 ? '' : 's'}`
              : ''}
          </Text>
          <View style={styles.navRow}>
            <TouchableOpacity
              style={[styles.navButton, atStart && styles.navButtonDisabled]}
              disabled={atStart}
              onPress={() => setFrameIndex(frameIndex - 1)}
            >
              <Text style={styles.navButtonText}>Previous</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.navButton, atEnd && styles.navButtonDisabled]}
              disabled={atEnd}
              onPress={() => setFrameIndex(frameIndex + 1)}
            >
              <Text style={styles.navButtonText}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 8,
  },
  wrap: {
    width: '100%',
    height: 280,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  frame: {
    width: '100%',
    height: '100%',
  },
  boxLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  box: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  chrome: {
    gap: 8,
  },
  tapHint: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 18,
  },
  pageLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
  },
  navRow: {
    flexDirection: 'row',
    gap: 10,
  },
  navButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  navButtonDisabled: {
    backgroundColor: '#94a3b8',
  },
  navButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 13,
  },
});
