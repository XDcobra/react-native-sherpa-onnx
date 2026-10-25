/**
 * Preview one OfflineImageBuffer frame; when frameCount > 1, prev/next pager.
 * FrameView ensures lazy-lru PDF pages on access.
 */

import { useEffect, useState } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  OfflineImageBufferFrameView,
  type OfflineImageBufferIdSource,
} from 'react-native-sherpa-onnx/imagebuffer';
import { framePagerStyles as s } from './OfflineImageBufferFramePager.styles';

export type OfflineImageBufferFramePagerProps = {
  buffer: OfflineImageBufferIdSource;
  frameCount: number;
  /** Display downsample; default 1280. */
  maxSide?: number;
  style?: StyleProp<ViewStyle>;
  frameStyle?: StyleProp<ViewStyle>;
};

export function OfflineImageBufferFramePager({
  buffer,
  frameCount,
  maxSide = 1280,
  style,
  frameStyle,
}: OfflineImageBufferFramePagerProps) {
  const total = Math.max(0, Math.trunc(frameCount));
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex((i) => {
      if (total <= 0) return 0;
      return Math.min(Math.max(0, i), total - 1);
    });
  }, [total, buffer]);

  if (total <= 0) {
    return null;
  }

  const showChrome = total > 1;
  const atStart = frameIndex <= 0;
  const atEnd = frameIndex >= total - 1;

  return (
    <View style={[s.root, style]}>
      <OfflineImageBufferFrameView
        buffer={buffer}
        frameIndex={frameIndex}
        maxSide={maxSide}
        resizeMode="contain"
        style={[s.frame, frameStyle]}
      />
      {showChrome ? (
        <View style={s.chrome}>
          <Text style={s.pageLabel}>
            Page {frameIndex + 1} / {total}
          </Text>
          <View style={s.navRow}>
            <TouchableOpacity
              style={[s.navButton, atStart && s.navButtonDisabled]}
              disabled={atStart}
              onPress={() => setFrameIndex((i) => Math.max(0, i - 1))}
            >
              <Text style={s.navButtonText}>Previous</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.navButton, atEnd && s.navButtonDisabled]}
              disabled={atEnd}
              onPress={() => setFrameIndex((i) => Math.min(total - 1, i + 1))}
            >
              <Text style={s.navButtonText}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}
