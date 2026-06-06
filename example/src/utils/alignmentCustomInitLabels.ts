import type { AlignmentCustomPathKey } from 'react-native-sherpa-onnx/alignment';

/** Human-readable labels for alignment custom path keys (example app UI). */
export const ALIGNMENT_CUSTOM_PATH_LABELS: Record<
  AlignmentCustomPathKey,
  string
> = {
  model: 'Wav2vec2 alignment model (.onnx)',
};

export function labelForAlignmentCustomPathKey(
  key: AlignmentCustomPathKey
): string {
  return ALIGNMENT_CUSTOM_PATH_LABELS[key] ?? key;
}
