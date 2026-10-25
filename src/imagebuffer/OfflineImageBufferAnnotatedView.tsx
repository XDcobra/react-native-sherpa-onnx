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
  image: OfflineImageBufferIdSource;
  /** Caller-owned offline text buffer (spatial spans). */
  text: OfflineTextBufferIdSource;
  frameIndex?: number;
  origins?: MapTextSpatialSpansToFrameOrigin[];
  selectedIndex?: number | null;
  onSpanPress?: (event: OfflineImageBufferSpanPressEvent) => void;
  maxSide?: number;
  resizeMode?: ImageFrameResizeMode;
  style?: StyleProp<ViewStyle>;
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

/**
 * FrameView plus mapped spatial-span boxes (OCR pixels / textLayer user-space).
 * Does not take ownership of `image` or `text`.
 */
export function OfflineImageBufferAnnotatedView({
  image,
  text,
  frameIndex = 0,
  origins,
  selectedIndex = null,
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
    getOfflineImageBufferFrameInfo(image, frameIndex)
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
  }, [image, frameIndex]);

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

  const mapped = React.useMemo(
    () =>
      mapTextSpatialSpansToFrame(spans, {
        frameIndex,
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        origins,
      }),
    [frameIndex, frameSize.height, frameSize.width, origins, spans]
  );

  const scale = React.useMemo(() => {
    if (
      layout.width <= 0 ||
      layout.height <= 0 ||
      frameSize.width <= 0 ||
      frameSize.height <= 0
    ) {
      return 1;
    }
    return Math.min(
      layout.width / frameSize.width,
      layout.height / frameSize.height
    );
  }, [frameSize.height, frameSize.width, layout.height, layout.width]);

  const drawnW = frameSize.width * scale;
  const drawnH = frameSize.height * scale;
  const offsetX = (layout.width - drawnW) / 2;
  const offsetY = (layout.height - drawnH) / 2;

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
        buffer={image}
        frameIndex={frameIndex}
        maxSide={maxSide}
        resizeMode={resizeMode}
        style={styles.frame}
      />
      {layout.width > 0 ? (
        <View style={styles.boxLayer} pointerEvents="box-none">
          {mapped.map((row) => {
            const box = aabbFromQuad(row.quad);
            const selected = selectedIndex === row.index;
            return (
              <TouchableOpacity
                key={`span-${row.index}`}
                activeOpacity={0.8}
                onPress={() => onPressMapped(row)}
                style={[
                  styles.box,
                  {
                    left: offsetX + box.left * scale,
                    top: offsetY + box.top * scale,
                    width: box.width * scale,
                    height: box.height * scale,
                    backgroundColor: selected
                      ? 'rgba(255, 59, 48, 0.45)'
                      : 'rgba(0, 122, 255, 0.28)',
                    borderColor: selected ? '#FF3B30' : '#007AFF',
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
