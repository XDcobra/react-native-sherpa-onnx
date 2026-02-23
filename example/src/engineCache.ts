/**
 * Persists STT/TTS engine instances and UI state across screen navigation.
 * When the user leaves a screen, the instance is not released; when they return,
 * the same state (selected model, Free button visible) is restored.
 *
 * **Lifecycle note:** These module-level caches persist for the lifetime of the JS context.
 * If the JS context is reloaded (e.g. on hot reload or app restart), native instances will
 * not be automatically destroyed and may leak. Call `clearTtsCache` / `clearSttCache` and
 * `.destroy()` on the cached engine in app lifecycle hooks (e.g. AppState 'change' to
 * 'background' or before reloading the bundle) to free native resources.
 */

import type { SttEngine } from 'react-native-sherpa-onnx/stt';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';
import type { STTModelType } from 'react-native-sherpa-onnx/stt';
import type { TTSModelType } from 'react-native-sherpa-onnx/tts';

// --- STT cache ---

let sttEngine: SttEngine | null = null;
let sttModelFolder: string | null = null;
let sttDetectedModels: Array<{ type: STTModelType; modelDir: string }> = [];
let sttSelectedModelType: STTModelType | null = null;

export function getSttCache(): {
  engine: SttEngine | null;
  modelFolder: string | null;
  detectedModels: Array<{ type: STTModelType; modelDir: string }>;
  selectedModelType: STTModelType | null;
} {
  return {
    engine: sttEngine,
    modelFolder: sttModelFolder,
    detectedModels: [...sttDetectedModels],
    selectedModelType: sttSelectedModelType,
  };
}

export function setSttCache(
  engine: SttEngine,
  modelFolder: string,
  detectedModels: Array<{ type: STTModelType; modelDir: string }>,
  selectedModelType: STTModelType | null
): void {
  sttEngine = engine;
  sttModelFolder = modelFolder;
  sttDetectedModels = detectedModels;
  sttSelectedModelType = selectedModelType;
}

export function clearSttCache(): void {
  sttEngine = null;
  sttModelFolder = null;
  sttDetectedModels = [];
  sttSelectedModelType = null;
}

// --- TTS cache ---

let ttsEngine: TtsEngine | null = null;
let ttsModelFolder: string | null = null;
let ttsDetectedModels: Array<{ type: TTSModelType; modelDir: string }> = [];
let ttsSelectedModelType: TTSModelType | null = null;
let ttsModelInfo: { sampleRate: number; numSpeakers: number } | null = null;

export function getTtsCache(): {
  engine: TtsEngine | null;
  modelFolder: string | null;
  detectedModels: Array<{ type: TTSModelType; modelDir: string }>;
  selectedModelType: TTSModelType | null;
  modelInfo: { sampleRate: number; numSpeakers: number } | null;
} {
  return {
    engine: ttsEngine,
    modelFolder: ttsModelFolder,
    detectedModels: [...ttsDetectedModels],
    selectedModelType: ttsSelectedModelType,
    modelInfo: ttsModelInfo ? { ...ttsModelInfo } : null,
  };
}

export function setTtsCache(
  engine: TtsEngine,
  modelFolder: string,
  detectedModels: Array<{ type: TTSModelType; modelDir: string }>,
  selectedModelType: TTSModelType | null,
  modelInfo: { sampleRate: number; numSpeakers: number } | null
): void {
  ttsEngine = engine;
  ttsModelFolder = modelFolder;
  ttsDetectedModels = detectedModels;
  ttsSelectedModelType = selectedModelType;
  ttsModelInfo = modelInfo;
}

export function clearTtsCache(): void {
  ttsEngine = null;
  ttsModelFolder = null;
  ttsDetectedModels = [];
  ttsSelectedModelType = null;
  ttsModelInfo = null;
}
