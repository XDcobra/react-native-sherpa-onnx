import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Test method to verify sherpa-onnx native library is loaded.
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
   * Extract a .tar.bz2 archive to a target folder.
   * Returns { success, path } or { success, reason }.
   */
  extractTarBz2(
    sourcePath: string,
    targetPath: string,
    force: boolean
  ): Promise<{ success: boolean; path?: string; reason?: string }>;

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

  // ==================== STT Methods ====================

  /**
   * Transcribe an audio file.
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
    debug: boolean,
    noiseScale?: number,
    noiseScaleW?: number,
    lengthScale?: number
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
  }>;

  /**
   * Update TTS model parameters by re-initializing with stored config.
   * @param noiseScale - Optional noise scale override
   * @param noiseScaleW - Optional noise scale W override
   * @param lengthScale - Optional length scale override
   * @returns Object with success boolean and array of detected models
   */
  updateTtsParams(
    noiseScale?: number | null,
    noiseScaleW?: number | null,
    lengthScale?: number | null
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
   * Generate speech with subtitle/timestamp metadata.
   * @param text - Text to convert to speech
   * @param sid - Speaker ID for multi-speaker models (default: 0)
   * @param speed - Speech speed multiplier (default: 1.0)
   * @returns Object with samples, sampleRate, subtitles, and estimated flag
   */
  generateTtsWithTimestamps(
    text: string,
    sid: number,
    speed: number
  ): Promise<{
    samples: number[];
    sampleRate: number;
    subtitles: Array<{ text: string; start: number; end: number }>;
    estimated: boolean;
  }>;

  /**
   * Generate speech in streaming mode (emits chunk events).
   * @param text - Text to convert to speech
   * @param sid - Speaker ID for multi-speaker models (default: 0)
   * @param speed - Speech speed multiplier (default: 1.0)
   */
  generateTtsStream(text: string, sid: number, speed: number): Promise<void>;

  /**
   * Cancel an ongoing streaming TTS generation.
   */
  cancelTtsStream(): Promise<void>;

  /**
   * Start PCM playback for streaming TTS.
   * @param sampleRate - Sample rate in Hz
   * @param channels - Number of channels (1 = mono)
   */
  startTtsPcmPlayer(sampleRate: number, channels: number): Promise<void>;

  /**
   * Write PCM samples to the streaming TTS player.
   * @param samples - Float PCM samples in range [-1.0, 1.0]
   */
  writeTtsPcmChunk(samples: number[]): Promise<void>;

  /**
   * Stop PCM playback for streaming TTS.
   */
  stopTtsPcmPlayer(): Promise<void>;

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
   * Save TTS audio samples to a WAV file.
   * @param samples - Audio samples array
   * @param sampleRate - Sample rate in Hz
   * @param filePath - Absolute path where to save the WAV file
   * @returns The file path where audio was saved
   */
  saveTtsAudioToFile(
    samples: number[],
    sampleRate: number,
    filePath: string
  ): Promise<string>;

  /**
   * Save TTS audio samples to a WAV file via Android SAF content URI.
   * @param samples - Audio samples array
   * @param sampleRate - Sample rate in Hz
   * @param directoryUri - Directory content URI (tree or document)
   * @param filename - Desired file name (e.g., tts_123.wav)
   * @returns The content URI of the saved file
   */
  saveTtsAudioToContentUri(
    samples: number[],
    sampleRate: number,
    directoryUri: string,
    filename: string
  ): Promise<string>;

  /**
   * Save a text file via Android SAF content URI.
   * @param text - Text content to write
   * @param directoryUri - Directory content URI (tree or document)
   * @param filename - Desired file name (e.g., tts_123.srt)
   * @param mimeType - MIME type (e.g., application/x-subrip)
   * @returns The content URI of the saved file
   */
  saveTtsTextToContentUri(
    text: string,
    directoryUri: string,
    filename: string,
    mimeType: string
  ): Promise<string>;

  /**
   * Copy a SAF content URI to a cache file for local playback.
   * @param fileUri - Content URI of the saved WAV file
   * @param filename - Desired cache filename
   * @returns Absolute file path to the cached copy
   */
  copyTtsContentUriToCache(fileUri: string, filename: string): Promise<string>;

  /**
   * Share a TTS audio file (file path or content URI).
   * @param fileUri - File path or content URI
   * @param mimeType - MIME type (e.g., audio/wav)
   */
  shareTtsAudio(fileUri: string, mimeType: string): Promise<void>;

  // ==================== Helper Methods ====================

  /**
   * List all model folders in the assets/models directory.
   * Scans the platform-specific model directory and returns folder names.
   *
   * @returns Array of model info objects found in assets/models/ (Android) or bundle models/ (iOS)
   *
   * @example
   * ```typescript
   * const folders = await listAssetModels();
   * // Returns: [{ folder: 'sherpa-onnx-streaming-zipformer-en-2023-06-26', hint: 'stt' }, { folder: 'sherpa-onnx-matcha-icefall-en_US-ljspeech', hint: 'tts' }]
   *
   * // Then use with resolveModelPath and initialize:
   * for (const model of folders) {
   *   const path = await resolveModelPath({ type: 'asset', path: `models/${model.folder}` });
   *   const result = await initializeSherpaOnnx(path);
   *   if (result.success) {
   *     console.log(`Found models in ${model.folder}:`, result.detectedModels);
   *   }
   * }
   * ```
   */
  listAssetModels(): Promise<
    Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>
  >;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
