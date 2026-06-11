import { types } from '@react-native-documents/picker';

/**
 * Document-picker filter for SDK-decodable inputs (see audioConfig CODEC_ASSET_ENTRIES).
 *
 * `types.audio` alone is insufficient on Android: MKV/WebM are often exposed as
 * video/* (e.g. video/x-matroska, video/webm), not audio/*.
 */
export const DECODABLE_AUDIO_PICKER_TYPES: string[] = [
  types.audio,
  types.video,
  'audio/webm',
  'video/webm',
  'video/x-matroska',
];
