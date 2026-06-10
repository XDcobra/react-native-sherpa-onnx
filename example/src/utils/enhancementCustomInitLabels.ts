import type { EnhancementCustomPathKey } from 'react-native-sherpa-onnx/enhancement';

/** Human-readable labels for enhancement custom init path keys (example app UI). */
export const ENHANCEMENT_CUSTOM_PATH_LABELS: Record<
  EnhancementCustomPathKey,
  string
> = {
  model: 'Enhancement model (.onnx)',
};

export function labelForEnhancementCustomPathKey(
  key: EnhancementCustomPathKey
): string {
  return ENHANCEMENT_CUSTOM_PATH_LABELS[key] ?? key;
}
