/**
 * Persists feature engine instances and UI state across screen navigation.
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
import type {
  OcrConcreteModelType,
  OcrEngine,
} from 'react-native-sherpa-onnx/ocr';
import type { OfflinePunctuationEngine } from 'react-native-sherpa-onnx/punctuation';
import type { AudioTaggingEngine } from 'react-native-sherpa-onnx/audio-tagging';
import type { LanguageIdentificationEngine } from 'react-native-sherpa-onnx/language-identification';
import type { KeywordSpottingEngine } from 'react-native-sherpa-onnx/kws';
import type { VADEngine } from 'react-native-sherpa-onnx/vad';
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

// --- OCR cache ---

let ocrEngine: OcrEngine | null = null;
let ocrModelFolder: string | null = null;
let ocrEngineFamily: OcrConcreteModelType | null = null;
let ocrInitMessage: string | null = null;
let ocrDetectSummary: string | null = null;

export function getOcrCache(): {
  engine: OcrEngine | null;
  modelFolder: string | null;
  engineFamily: OcrConcreteModelType | null;
  initMessage: string | null;
  detectSummary: string | null;
} {
  return {
    engine: ocrEngine,
    modelFolder: ocrModelFolder,
    engineFamily: ocrEngineFamily,
    initMessage: ocrInitMessage,
    detectSummary: ocrDetectSummary,
  };
}

export function setOcrCache(
  engine: OcrEngine,
  modelFolder: string,
  engineFamily: OcrConcreteModelType | null,
  initMessage: string | null,
  detectSummary: string | null
): void {
  ocrEngine = engine;
  ocrModelFolder = modelFolder;
  ocrEngineFamily = engineFamily;
  ocrInitMessage = initMessage;
  ocrDetectSummary = detectSummary;
}

export function clearOcrCache(): void {
  ocrEngine = null;
  ocrModelFolder = null;
  ocrEngineFamily = null;
  ocrInitMessage = null;
  ocrDetectSummary = null;
}

// --- Offline punctuation cache ---

let punctuationEngine: OfflinePunctuationEngine | null = null;
let punctuationModelFolder: string | null = null;
let punctuationInitMessage: string | null = null;

export function getPunctuationCache(): {
  engine: OfflinePunctuationEngine | null;
  modelFolder: string | null;
  initMessage: string | null;
} {
  return {
    engine: punctuationEngine,
    modelFolder: punctuationModelFolder,
    initMessage: punctuationInitMessage,
  };
}

export function setPunctuationCache(
  engine: OfflinePunctuationEngine,
  modelFolder: string,
  initMessage: string | null
): void {
  punctuationEngine = engine;
  punctuationModelFolder = modelFolder;
  punctuationInitMessage = initMessage;
}

export function clearPunctuationCache(): void {
  punctuationEngine = null;
  punctuationModelFolder = null;
  punctuationInitMessage = null;
}

// --- Audio tagging cache ---

let audioTaggingEngine: AudioTaggingEngine | null = null;
let audioTaggingModelFolder: string | null = null;
let audioTaggingInitMessage: string | null = null;

export function getAudioTaggingCache(): {
  engine: AudioTaggingEngine | null;
  modelFolder: string | null;
  initMessage: string | null;
} {
  return {
    engine: audioTaggingEngine,
    modelFolder: audioTaggingModelFolder,
    initMessage: audioTaggingInitMessage,
  };
}

export function setAudioTaggingCache(
  engine: AudioTaggingEngine,
  modelFolder: string,
  initMessage: string | null
): void {
  audioTaggingEngine = engine;
  audioTaggingModelFolder = modelFolder;
  audioTaggingInitMessage = initMessage;
}

export function clearAudioTaggingCache(): void {
  audioTaggingEngine = null;
  audioTaggingModelFolder = null;
  audioTaggingInitMessage = null;
}

// --- Language ID cache ---

let languageIdEngine: LanguageIdentificationEngine | null = null;
let languageIdModelFolder: string | null = null;
let languageIdInitMessage: string | null = null;

export function getLanguageIdCache(): {
  engine: LanguageIdentificationEngine | null;
  modelFolder: string | null;
  initMessage: string | null;
} {
  return {
    engine: languageIdEngine,
    modelFolder: languageIdModelFolder,
    initMessage: languageIdInitMessage,
  };
}

export function setLanguageIdCache(
  engine: LanguageIdentificationEngine,
  modelFolder: string,
  initMessage: string | null
): void {
  languageIdEngine = engine;
  languageIdModelFolder = modelFolder;
  languageIdInitMessage = initMessage;
}

export function clearLanguageIdCache(): void {
  languageIdEngine = null;
  languageIdModelFolder = null;
  languageIdInitMessage = null;
}

// --- KWS cache ---

let kwsEngine: KeywordSpottingEngine | null = null;
let kwsModelFolder: string | null = null;
let kwsInitMessage: string | null = null;

export function getKwsCache(): {
  engine: KeywordSpottingEngine | null;
  modelFolder: string | null;
  initMessage: string | null;
} {
  return {
    engine: kwsEngine,
    modelFolder: kwsModelFolder,
    initMessage: kwsInitMessage,
  };
}

export function setKwsCache(
  engine: KeywordSpottingEngine,
  modelFolder: string,
  initMessage: string | null
): void {
  kwsEngine = engine;
  kwsModelFolder = modelFolder;
  kwsInitMessage = initMessage;
}

export function clearKwsCache(): void {
  kwsEngine = null;
  kwsModelFolder = null;
  kwsInitMessage = null;
}

// --- VAD cache ---

let vadEngine: VADEngine | null = null;
let vadModelFolder: string | null = null;
let vadInitMessage: string | null = null;

export function getVadCache(): {
  engine: VADEngine | null;
  modelFolder: string | null;
  initMessage: string | null;
} {
  return {
    engine: vadEngine,
    modelFolder: vadModelFolder,
    initMessage: vadInitMessage,
  };
}

export function setVadCache(
  engine: VADEngine,
  modelFolder: string,
  initMessage: string | null
): void {
  vadEngine = engine;
  vadModelFolder = modelFolder;
  vadInitMessage = initMessage;
}

export function clearVadCache(): void {
  vadEngine = null;
  vadModelFolder = null;
  vadInitMessage = null;
}
