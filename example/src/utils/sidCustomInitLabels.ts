import type { SpeakerEmbeddingCustomPathKey } from 'react-native-sherpa-onnx/speaker-identification';

/** Human-readable labels for speaker-embedding custom init path keys (example app UI). */
export const SID_CUSTOM_PATH_LABELS: Record<
  SpeakerEmbeddingCustomPathKey,
  string
> = {
  model: 'Speaker embedding model (.onnx)',
};

export function labelForSidCustomPathKey(
  key: SpeakerEmbeddingCustomPathKey
): string {
  return SID_CUSTOM_PATH_LABELS[key] ?? key;
}
