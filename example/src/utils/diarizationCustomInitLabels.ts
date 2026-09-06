import type { DiarizationCustomPathKey } from 'react-native-sherpa-onnx/diarization';

/** Human-readable labels for diarization custom init path keys (example app UI). */
export const DIARIZATION_CUSTOM_PATH_LABELS: Record<
  DiarizationCustomPathKey,
  string
> = {
  model: 'Sortformer ONNX Model (.onnx, required)',
  metadata: 'Model Metadata (.json, optional)',
};

export function labelForDiarizationCustomPathKey(
  key: DiarizationCustomPathKey
): string {
  return DIARIZATION_CUSTOM_PATH_LABELS[key] ?? key;
}
