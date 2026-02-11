import { ModelCategory } from 'react-native-sherpa-onnx/download';

/**
 * Curated list of recommended models for each category.
 * These are suitable for beginners - good balance of quality, size, and speed.
 */
export const RECOMMENDED_MODEL_IDS: Record<string, string[]> = {
  [ModelCategory.Tts]: [
    'vits-piper-en_GB-jenny-medium', // Female voice, English GB
    'vits-piper-en_US-lessac-low', // Male voice, English US, smaller
  ],
  [ModelCategory.Stt]: [
    'sherpa-onnx-en-zipformer-small', // Fast, reasonably accurate
    'sherpa-onnx-en-conformer-tiny-2024-08-19', // Ultra-small, fast
  ],
  [ModelCategory.Vad]: [
    'silero-vad', // Lightweight VAD
  ],
  [ModelCategory.Diarization]: [
    'sherpa-onnx-speaker-diarization-en', // Default diarization
  ],
  [ModelCategory.Enhancement]: [
    'sherpa-onnx-speech-enhancement-1d-cn', // Default enhancement
  ],
  [ModelCategory.Separation]: [
    'sherpa-onnx-source-separation-model', // Default separation
  ],
};

/**
 * Model size tier information with icon names for display.
 */
export interface SizeHintInfo {
  tier: string;
  description: string;
  iconName: string;
  iconColor: string;
}

export const MODEL_SIZE_HINTS: Record<string, SizeHintInfo> = {
  tiny: {
    tier: 'Tiny',
    description: 'Very small (~10-50MB), fast, suitable for basic use',
    iconName: 'flash',
    iconColor: '#00AA00',
  },
  small: {
    tier: 'Small',
    description: 'Compact (~50-150MB), good speed, decent quality',
    iconColor: '#FFAA00',
    iconName: 'checkmark-circle',
  },
  medium: {
    tier: 'Medium',
    description: 'Moderate size (~150-300MB), balanced quality & speed',
    iconName: 'settings',
    iconColor: '#FF8800',
  },
  large: {
    tier: 'Large',
    description: 'Large (>300MB), slower, best quality & accuracy',
    iconName: 'star',
    iconColor: '#FF0000',
  },
  unknown: {
    tier: 'Unknown',
    description: 'Size unknown, check before downloading',
    iconName: 'help-circle',
    iconColor: '#999999',
  },
};

/**
 * Get size tier hint for a model ID or bytes.
 * Returns icon name, color, and description for display.
 */
export function getSizeHint(id: string, bytes?: number): SizeHintInfo {
  const idLower = id.toLowerCase();
  const unknownFallback: SizeHintInfo = MODEL_SIZE_HINTS.unknown ?? {
    tier: 'Unknown',
    description: 'Size unknown',
    iconName: 'help-circle',
    iconColor: '#999999',
  };

  // Try to infer from ID
  if (idLower.includes('tiny')) return MODEL_SIZE_HINTS.tiny ?? unknownFallback;
  if (idLower.includes('small') || idLower.includes('small-2024'))
    return MODEL_SIZE_HINTS.small ?? unknownFallback;
  if (idLower.includes('medium'))
    return MODEL_SIZE_HINTS.medium ?? unknownFallback;
  if (idLower.includes('large'))
    return MODEL_SIZE_HINTS.large ?? unknownFallback;

  // Try to infer from bytes
  if (bytes != null) {
    const mb = bytes / (1024 * 1024);
    if (mb < 50) return MODEL_SIZE_HINTS.tiny ?? unknownFallback;
    if (mb < 150) return MODEL_SIZE_HINTS.small ?? unknownFallback;
    if (mb < 300) return MODEL_SIZE_HINTS.medium ?? unknownFallback;
    return MODEL_SIZE_HINTS.large ?? unknownFallback;
  }

  return unknownFallback;
}

/**
 * Quality hint information with icon names for display.
 */
export interface QualityHintInfo {
  text: string;
  iconName: string;
  iconColor: string;
}

/**
 * Get quality hint based on model tier.
 */
export function getQualityHint(id: string): QualityHintInfo {
  const idLower = id.toLowerCase();

  if (
    idLower.includes('tiny') ||
    idLower.includes('small-2024') ||
    idLower.includes('conformer-tiny')
  ) {
    return {
      text: 'Fast, good for real-time',
      iconName: 'flash',
      iconColor: '#FFA500',
    };
  }

  if (idLower.includes('small')) {
    return {
      text: 'Balanced speed & quality',
      iconName: 'swap-horizontal',
      iconColor: '#4CAF50',
    };
  }

  if (idLower.includes('medium')) {
    return {
      text: 'Good quality, moderate speed',
      iconName: 'aperture',
      iconColor: '#2196F3',
    };
  }

  if (idLower.includes('large')) {
    return {
      text: 'Best quality, slower',
      iconName: 'star',
      iconColor: '#FFD700',
    };
  }

  return {
    text: 'Check details',
    iconName: 'help-circle',
    iconColor: '#999999',
  };
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = (bytes / Math.pow(k, i)).toFixed(1);
  return `${value} ${sizes[i]}`;
}
