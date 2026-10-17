import { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import type { TextSpatialSpan } from 'react-native-sherpa-onnx/textbuffer';

type Props = {
  previewUri: string | null;
  /** Decoded frame size (OCR quad coordinate space). */
  frameWidth: number;
  frameHeight: number;
  spans: TextSpatialSpan[];
  selectedIndex: number | null;
  onSelectIndex?: (index: number | null) => void;
  overlayEnabled: boolean;
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
 * Shows the source image and draws axis-aligned boxes from each span.quad
 * so developers can see that OCR returns pixel coordinates.
 */
export function OcrQuadOverlay({
  previewUri,
  frameWidth,
  frameHeight,
  spans,
  selectedIndex,
  onSelectIndex,
  overlayEnabled,
}: Props) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  const scale = useMemo(() => {
    if (
      layout.width <= 0 ||
      layout.height <= 0 ||
      frameWidth <= 0 ||
      frameHeight <= 0
    ) {
      return 1;
    }
    return Math.min(layout.width / frameWidth, layout.height / frameHeight);
  }, [layout, frameWidth, frameHeight]);

  const drawnW = frameWidth * scale;
  const drawnH = frameHeight * scale;
  const offsetX = (layout.width - drawnW) / 2;
  const offsetY = (layout.height - drawnH) / 2;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ width, height });
  };

  if (!previewUri) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No preview URI for overlay.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <Image
        source={{ uri: previewUri }}
        style={styles.image}
        resizeMode="contain"
      />
      {overlayEnabled && layout.width > 0
        ? spans.map((span, index) => {
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
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    height: 280,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
  box: {
    position: 'absolute',
    borderWidth: 1.5,
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
