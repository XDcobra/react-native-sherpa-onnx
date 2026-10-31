import * as React from 'react';
import {
  requireNativeComponent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { ImageFrameResizeMode, OfflineImageBufferIdSource } from './types';

type NativeProps = {
  bufferId: string;
  frameIndex?: number;
  maxSide?: number;
  resizeMode?: ImageFrameResizeMode;
  style?: StyleProp<ViewStyle>;
};

const NativeOfflineImageBufferFrameView = requireNativeComponent<NativeProps>(
  'OfflineImageBufferFrameView'
);

function resolveBufferId(source: OfflineImageBufferIdSource): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && 'bufferId' in source) {
    return String((source as { bufferId: string }).bufferId);
  }
  throw new Error('ERR_IMAGE_INVALID_ARGUMENT: invalid OfflineImageBuffer id');
}

export type OfflineImageBufferFrameViewProps = {
  /** Offline ImageBuffer, or a finished live (`img_live_*`) id. Recording live is rejected natively. */
  buffer: OfflineImageBufferIdSource;
  /** Frame index (default 0). */
  frameIndex?: number;
  /**
   * Optional display downsample of the longest edge.
   * Does not mutate the buffer. `<= 0` / omitted = full frame.
   */
  maxSide?: number;
  /** Default `contain`. */
  resizeMode?: ImageFrameResizeMode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Native preview of one OfflineImageBuffer frame.
 * Paints from native RGB (`GetFrameRgbPtr`) — no file materialize.
 */
export function OfflineImageBufferFrameView(
  props: OfflineImageBufferFrameViewProps
): React.ReactElement {
  const bufferId = resolveBufferId(props.buffer);
  return (
    <NativeOfflineImageBufferFrameView
      bufferId={bufferId}
      frameIndex={props.frameIndex ?? 0}
      maxSide={props.maxSide ?? 0}
      resizeMode={props.resizeMode ?? 'contain'}
      style={props.style}
    />
  );
}
