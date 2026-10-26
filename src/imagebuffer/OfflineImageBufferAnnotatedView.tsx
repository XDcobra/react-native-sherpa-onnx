import * as React from 'react';
import {
  StyleSheet,
  TouchableOpacity,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  getOfflineTextBufferSpatialSpansSlice,
  getPipelineTextBufferInfo,
  type OfflineTextBufferIdSource,
  type OfflineTextBufferInfo,
  type TextSpatialSpan,
  type TextSpatialSpanLevel,
  type TextSpatialSpanOrigin,
} from '../textbuffer';
import { getOfflineImageBufferFrameInfo } from './getFrameInfo';
import { OfflineImageBufferFrameView } from './OfflineImageBufferFrameView';
import {
  mapTextSpatialSpansToFrame,
  type MapTextSpatialSpansToFrameOrigin,
  type MappedTextSpatialSpan,
} from './mapToFrame';

import type { ImageFrameResizeMode, OfflineImageBufferIdSource } from './types';

export type OfflineImageBufferSpanRange = {
  utf16Start: number;
  utf16End: number;
};

export type OfflineImageBufferSpanPressEvent = {
  index: number;
  utf16Start: number;
  utf16End: number;
  origin: TextSpatialSpanOrigin;
  frameIndex: number;
  /** Quad in decoded ImageBuffer frame pixels. */
  quad: TextSpatialSpan['quad'];
};

export type OfflineImageBufferAnnotatedViewProps = {
  buffer: OfflineImageBufferIdSource;
  /** Caller-owned offline text buffer (spatial spans). */
  text: OfflineTextBufferIdSource;
  frameIndex?: number;
  origins?: MapTextSpatialSpansToFrameOrigin[];
  /** Default: every level present on the mapped spans. */
  levels?: TextSpatialSpanLevel[];
  selectedIndex?: number | null;
  selectedRange?: OfflineImageBufferSpanRange | null;
  /**
   * Visual only. Position and size stay view-owned.
   * Merge: defaults → `boxStyle` → `originBoxStyle[origin]` → selected defaults → `selectedBoxStyle`.
   */
  boxStyle?: StyleProp<ViewStyle>;
  selectedBoxStyle?: StyleProp<ViewStyle>;
  originBoxStyle?: Partial<
    Record<MapTextSpatialSpansToFrameOrigin, StyleProp<ViewStyle>>
  >;
  onSpanPress?: (event: OfflineImageBufferSpanPressEvent) => void;
  maxSide?: number;
  resizeMode?: ImageFrameResizeMode;
  style?: StyleProp<ViewStyle>;
};

type FrameViewLayout = {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
};

const BOX_DEFAULT: ViewStyle = {
  backgroundColor: 'rgba(0, 122, 255, 0.28)',
  borderColor: '#007AFF',
  borderWidth: 1.5,
};

const BOX_SELECTED: ViewStyle = {
  backgroundColor: 'rgba(255, 59, 48, 0.45)',
  borderColor: '#FF3B30',
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

function flattenViewStyle(style: StyleProp<ViewStyle> | undefined): ViewStyle {
  if (style == null || style === false) {
    return {};
  }
  if (typeof StyleSheet.flatten === 'function') {
    return (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  }
  if (Array.isArray(style)) {
    return Object.assign(
      {},
      ...style.map((entry) => flattenViewStyle(entry as StyleProp<ViewStyle>))
    );
  }
  return style as ViewStyle;
}

const OWNED_BOX_KEYS = [
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'position',
  'transform',
] as const;

function stripOwnedBoxGeometry(style: ViewStyle): ViewStyle {
  const visual = { ...style };
  for (const key of OWNED_BOX_KEYS) {
    delete visual[key];
  }
  return visual;
}

/** @internal layout for contain / cover / stretch. Not a public helper. */
export function computeAnnotatedFrameLayout(
  layout: { width: number; height: number },
  frame: { width: number; height: number },
  resizeMode: ImageFrameResizeMode
): FrameViewLayout | null {
  if (
    layout.width <= 0 ||
    layout.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return null;
  }
  if (resizeMode === 'stretch') {
    return {
      scaleX: layout.width / frame.width,
      scaleY: layout.height / frame.height,
      offsetX: 0,
      offsetY: 0,
    };
  }
  const scale =
    resizeMode === 'cover'
      ? Math.max(layout.width / frame.width, layout.height / frame.height)
      : Math.min(layout.width / frame.width, layout.height / frame.height);
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: (layout.width - frame.width * scale) / 2,
    offsetY: (layout.height - frame.height * scale) / 2,
  };
}

/** @internal */
export function isAnnotatedSpanSelected(
  row: Pick<MappedTextSpatialSpan, 'index' | 'span'>,
  selectedIndex: number | null | undefined,
  selectedRange: OfflineImageBufferSpanRange | null | undefined
): boolean {
  if (selectedIndex != null && row.index === selectedIndex) {
    return true;
  }
  if (
    selectedRange == null ||
    !Number.isFinite(selectedRange.utf16Start) ||
    !Number.isFinite(selectedRange.utf16End) ||
    selectedRange.utf16End <= selectedRange.utf16Start
  ) {
    return false;
  }
  return (
    row.span.utf16Start < selectedRange.utf16End &&
    row.span.utf16End > selectedRange.utf16Start
  );
}

/** @internal */
export function resolveAnnotatedBoxStyle(
  origin: TextSpatialSpanOrigin,
  selected: boolean,
  boxStyle?: StyleProp<ViewStyle>,
  selectedBoxStyle?: StyleProp<ViewStyle>,
  originBoxStyle?: Partial<
    Record<MapTextSpatialSpansToFrameOrigin, StyleProp<ViewStyle>>
  >
): ViewStyle {
  const originStyle =
    origin === 'ocr' || origin === 'textLayer'
      ? originBoxStyle?.[origin]
      : undefined;
  return stripOwnedBoxGeometry(
    flattenViewStyle([
      BOX_DEFAULT,
      boxStyle,
      originStyle,
      selected ? BOX_SELECTED : null,
      selected ? selectedBoxStyle : null,
    ])
  );
}

function filterMappedByLevel(
  mapped: MappedTextSpatialSpan[],
  levels: TextSpatialSpanLevel[] | undefined
): MappedTextSpatialSpan[] {
  if (levels == null) {
    return mapped;
  }
  const allowed = new Set(levels);
  return mapped.filter((row) => allowed.has(row.span.level));
}

/**
 * FrameView plus mapped spatial-span boxes (OCR pixels / textLayer user-space).
 * Does not take ownership of `buffer` or `text`.
 */
export function OfflineImageBufferAnnotatedView({
  buffer,
  text,
  frameIndex = 0,
  origins,
  levels,
  selectedIndex = null,
  selectedRange = null,
  boxStyle,
  selectedBoxStyle,
  originBoxStyle,
  onSpanPress,
  maxSide,
  resizeMode = 'contain',
  style,
}: OfflineImageBufferAnnotatedViewProps): React.ReactElement {
  const [layout, setLayout] = React.useState({ width: 0, height: 0 });
  const [frameSize, setFrameSize] = React.useState({ width: 0, height: 0 });
  const [spans, setSpans] = React.useState<TextSpatialSpan[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    getOfflineImageBufferFrameInfo(buffer, frameIndex)
      .then((info) => {
        if (cancelled) return;
        setFrameSize({ width: info.width, height: info.height });
      })
      .catch(() => {
        if (!cancelled) setFrameSize({ width: 0, height: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, frameIndex]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = (await getPipelineTextBufferInfo(
          text
        )) as OfflineTextBufferInfo;
        if (cancelled) return;
        if (!info.hasSpatialSpans || info.spatialSpanCount <= 0) {
          setSpans([]);
          return;
        }
        const next = await getOfflineTextBufferSpatialSpansSlice(
          text,
          0,
          info.spatialSpanCount
        );
        if (!cancelled) setSpans(next);
      } catch {
        if (!cancelled) setSpans([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  const mapped = React.useMemo(() => {
    const projected = mapTextSpatialSpansToFrame(spans, {
      frameIndex,
      frameWidth: frameSize.width,
      frameHeight: frameSize.height,
      origins,
    });
    return filterMappedByLevel(projected, levels);
  }, [frameIndex, frameSize.height, frameSize.width, levels, origins, spans]);

  const viewLayout = React.useMemo(
    () => computeAnnotatedFrameLayout(layout, frameSize, resizeMode),
    [frameSize, layout, resizeMode]
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setLayout({ width, height });
  };

  const onPressMapped = (row: MappedTextSpatialSpan) => {
    onSpanPress?.({
      index: row.index,
      utf16Start: row.span.utf16Start,
      utf16End: row.span.utf16End,
      origin: row.span.origin,
      frameIndex: row.span.frameIndex,
      quad: row.quad,
    });
  };

  return (
    <View style={[styles.root, style]} onLayout={onLayout}>
      <OfflineImageBufferFrameView
        buffer={buffer}
        frameIndex={frameIndex}
        maxSide={maxSide}
        resizeMode={resizeMode}
        style={styles.frame}
      />
      {viewLayout != null ? (
        <View style={styles.boxLayer} pointerEvents="box-none">
          {mapped.map((row) => {
            const box = aabbFromQuad(row.quad);
            const selected = isAnnotatedSpanSelected(
              row,
              selectedIndex,
              selectedRange
            );
            return (
              <TouchableOpacity
                key={`span-${row.index}`}
                activeOpacity={0.8}
                onPress={() => onPressMapped(row)}
                style={[
                  styles.box,
                  resolveAnnotatedBoxStyle(
                    row.span.origin,
                    selected,
                    boxStyle,
                    selectedBoxStyle,
                    originBoxStyle
                  ),
                  {
                    left: viewLayout.offsetX + box.left * viewLayout.scaleX,
                    top: viewLayout.offsetY + box.top * viewLayout.scaleY,
                    width: Math.max(1, box.width * viewLayout.scaleX),
                    height: Math.max(1, box.height * viewLayout.scaleY),
                  },
                ]}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: 280,
    backgroundColor: '#f3f4f6',
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
});
