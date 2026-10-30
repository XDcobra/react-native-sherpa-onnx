import {
  requireNativeComponent,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { VideoPreviewViewProps } from './types';
import { Platform } from 'react-native';

type NativeProps = {
  playerId: string | null;
  resizeMode: string;
  style?: StyleProp<ViewStyle>;
};

const SurfaceNative = requireNativeComponent<NativeProps>(
  'SherpaOnnxVideoPreviewView'
);
const TextureNative = requireNativeComponent<NativeProps>(
  'SherpaOnnxVideoPreviewTextureView'
);

export function VideoPreviewView(props: VideoPreviewViewProps) {
  const {
    player,
    resizeMode = 'contain',
    androidViewType = 'surfaceView',
    style,
    ...rest
  } = props;
  const Native =
    Platform.OS === 'android' && androidViewType === 'textureView'
      ? TextureNative
      : SurfaceNative;
  if (player == null) {
    return <View style={style} {...rest} />;
  }
  return (
    <Native
      playerId={player.playerId}
      resizeMode={resizeMode}
      style={style}
      {...rest}
    />
  );
}
