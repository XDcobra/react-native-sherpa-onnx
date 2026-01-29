import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Test method to verify sherpa-onnx native library is loaded.
   * Phase 1: Minimal "Hello World" test.
   */
  testSherpaInit(): Promise<string>;

  /**
   * Resolve model path based on configuration.
   * Handles asset paths, file system paths, and auto-detection.
   * Returns an absolute path that can be used by native code.
   *
   * @param config - Object with 'type' ('asset' | 'file' | 'auto') and 'path' (string)
   */
  resolveModelPath(config: { type: string; path: string }): Promise<string>;

  /**
   * Initialize sherpa-onnx with model directory.
   * Expects an absolute path (use resolveModelPath first for asset/file paths).
   * @param modelDir - Absolute path to model directory
   * @param preferInt8 - Optional: true = prefer int8 models, false = prefer regular models, undefined = try int8 first (default)
   * @param modelType - Optional: explicit model type ('transducer', 'paraformer', 'nemo_ctc', 'auto'), undefined = auto (default)
   * @returns Object with success boolean and array of detected models (each with type and modelDir)
   */
  initializeSherpaOnnx(
    modelDir: string,
    preferInt8?: boolean,
    modelType?: string
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
  }>;

  /**
   * Transcribe an audio file.
   * Phase 1: Stub implementation.
   */
  transcribeFile(filePath: string): Promise<string>;

  /**
   * Release sherpa-onnx resources.
   */
  unloadSherpaOnnx(): Promise<void>;

  // ==================== TTS Methods ====================

  /**
   * Initialize Text-to-Speech (TTS) with model directory.
   * @param modelDir - Absolute path to model directory
   * @param modelType - Model type ('vits', 'matcha', 'kokoro', 'kitten', 'zipvoice', 'auto')
   * @param numThreads - Number of threads for inference (default: 2)
   * @param debug - Enable debug logging (default: false)
   * @returns Object with success boolean and array of detected models (each with type and modelDir)
   */
  initializeTts(
    modelDir: string,
    modelType: string,
    numThreads: number,
    debug: boolean
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
  }>;

  /**
   * Generate speech from text.
   * @param text - Text to convert to speech
   * @param sid - Speaker ID for multi-speaker models (default: 0)
   * @param speed - Speech speed multiplier (default: 1.0)
   * @returns Object with { samples: number[], sampleRate: number }
   */
  generateTts(
    text: string,
    sid: number,
    speed: number
  ): Promise<{ samples: number[]; sampleRate: number }>;

  /**
   * Get the sample rate of the initialized TTS model.
   * @returns Sample rate in Hz
   */
  getTtsSampleRate(): Promise<number>;

  /**
   * Get the number of speakers/voices available in the model.
   * @returns Number of speakers (0 or 1 for single-speaker models)
   */
  getTtsNumSpeakers(): Promise<number>;

  /**
   * Release TTS resources.
   */
  unloadTts(): Promise<void>;

  /**
   * List all model folders in the assets/models directory.
   * Scans the platform-specific model directory and returns folder names.
   *
   * @returns Array of folder names found in assets/models/ (Android) or bundle models/ (iOS)
   *
   * @example
   * ```typescript
   * const folders = await listAssetModels();
   * // Returns: ['sherpa-onnx-streaming-zipformer-en-2023-06-26', 'sherpa-onnx-matcha-icefall-en_US-ljspeech']
   *
   * // Then use with resolveModelPath and initialize:
   * for (const folder of folders) {
   *   const path = await resolveModelPath({ type: 'asset', path: `models/${folder}` });
   *   const result = await initializeSherpaOnnx(path);
   *   if (result.success) {
   *     console.log(`Found models in ${folder}:`, result.detectedModels);
   *   }
   * }
   * ```
   */
  listAssetModels(): Promise<string[]>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
