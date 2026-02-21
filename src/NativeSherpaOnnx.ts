import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Test method to verify sherpa-onnx native library is loaded.
   */
  testSherpaInit(): Promise<string>;

  // ==================== STT Methods ====================

  /**
   * Initialize Speech-to-Text (STT) with model directory.
   * Expects an absolute path (use resolveModelPath first for asset/file paths).
   * @param modelDir - Absolute path to model directory
   * @param preferInt8 - Optional: true = prefer int8 models, false = prefer regular models, undefined = try int8 first (default)
   * @param modelType - Optional: explicit model type ('transducer', 'nemo_transducer', 'paraformer', 'nemo_ctc', 'wenet_ctc', 'sense_voice', 'zipformer_ctc', 'whisper', 'funasr_nano', 'fire_red_asr', 'moonshine', 'dolphin', 'canary', 'omnilingual', 'medasr', 'telespeech_ctc', 'auto'), undefined = auto (default)
   * @param debug - Optional: enable debug logging in native layer and sherpa-onnx (default: false)
   * @param hotwordsFile - Optional: path to hotwords file (OfflineRecognizerConfig)
   * @param hotwordsScore - Optional: hotwords score (default in Kotlin 1.5)
   * @param numThreads - Optional: number of threads for inference (default in Kotlin: 1)
   * @param provider - Optional: provider string e.g. 'cpu' (stored in config only)
   * @param ruleFsts - Optional: path(s) to rule FSTs for ITN (comma-separated)
   * @param ruleFars - Optional: path(s) to rule FARs for ITN (comma-separated)
   * @param dither - Optional: dither for feature extraction (default 0)
   * @param modelOptions - Optional: model-specific options (whisper, senseVoice, canary, funasrNano). Only the block for the loaded model type is applied.
   * @param modelingUnit - Optional: 'cjkchar' | 'bpe' | 'cjkchar+bpe' for hotwords tokenization (OfflineModelConfig.modelingUnit)
   * @param bpeVocab - Optional: path to BPE vocab file (OfflineModelConfig.bpeVocab), used when modelingUnit is bpe or cjkchar+bpe
   * @returns Object with success boolean and array of detected models (each with type and modelDir)
   */
  initializeStt(
    modelDir: string,
    preferInt8?: boolean,
    modelType?: string,
    debug?: boolean,
    hotwordsFile?: string,
    hotwordsScore?: number,
    numThreads?: number,
    provider?: string,
    ruleFsts?: string,
    ruleFars?: string,
    dither?: number,
    modelOptions?: Object,
    modelingUnit?: string,
    bpeVocab?: string
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    decodingMethod?: string;
  }>;

  /**
   * Detect STT model type and structure without initializing the recognizer.
   * Uses the same native file-based detection as initializeStt. Useful to show model-specific
   * options before init or to query the type for a given path.
   * @param modelDir - Absolute path to model directory (use resolveModelPath first for asset/file paths)
   * @param preferInt8 - Optional: true = prefer int8, false = prefer regular, undefined = try int8 first
   * @param modelType - Optional: explicit type or 'auto' (default)
   * @returns Object with success, detectedModels (array of { type, modelDir }), and modelType (primary detected type)
   */
  detectSttModel(
    modelDir: string,
    preferInt8?: boolean,
    modelType?: string
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
  }>;

  /**
   * Transcribe an audio file. Returns full recognition result (text, tokens, timestamps, lang, emotion, event, durations).
   */
  transcribeFile(filePath: string): Promise<{
    text: string;
    tokens: string[];
    timestamps: number[];
    lang: string;
    emotion: string;
    event: string;
    durations: number[];
  }>;

  /**
   * Transcribe from float PCM samples (e.g. from microphone). Same return type as transcribeFile.
   */
  transcribeSamples(
    samples: number[],
    sampleRate: number
  ): Promise<{
    text: string;
    tokens: string[];
    timestamps: number[];
    lang: string;
    emotion: string;
    event: string;
    durations: number[];
  }>;

  /**
   * Update recognizer config at runtime (decodingMethod, maxActivePaths, hotwordsFile, hotwordsScore, blankPenalty, ruleFsts, ruleFars).
   */
  setSttConfig(options: Object): Promise<void>;

  /**
   * Release STT resources.
   */
  unloadStt(): Promise<void>;

  // ==================== TTS Methods ====================

  /**
   * Initialize Text-to-Speech (TTS) with model directory.
   * @param modelDir - Absolute path to model directory
   * @param modelType - Model type ('vits', 'matcha', 'kokoro', 'kitten', 'pocket', 'zipvoice', 'auto')
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
    sampleRate: number;
    numSpeakers: number;
  }>;

  /**
   * Detect TTS model type and structure without initializing the engine.
   * Uses the same native file-based detection as initializeTts.
   * @param modelDir - Absolute path to model directory (use resolveModelPath first for asset/file paths)
   * @param modelType - Optional: explicit type or 'auto' (default)
   * @returns Object with success, detectedModels (array of { type, modelDir }), and modelType (primary detected type)
   */
  detectTtsModel(
    modelDir: string,
    modelType?: string
  ): Promise<{
    success: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
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
    sampleRate: number;
    numSpeakers: number;
  }>;

  /**
   * Generate speech from text.
   * @param text - Text to convert to speech
   * @param options - Generation options (sid, speed, referenceAudio, referenceText, numSteps, silenceScale, extra)
   * @returns Object with { samples: number[], sampleRate: number }
   */
  generateTts(
    text: string,
    options: Object
  ): Promise<{
    samples: number[];
    sampleRate: number;
  }>;

  /**
   * Generate speech with subtitle/timestamp metadata.
   * @param text - Text to convert to speech
   * @param options - Generation options (sid, speed, referenceAudio, referenceText, numSteps, silenceScale, extra)
   * @returns Object with samples, sampleRate, subtitles, and estimated flag
   */
  generateTtsWithTimestamps(
    text: string,
    options: Object
  ): Promise<{
    samples: number[];
    sampleRate: number;
    subtitles: Array<{ text: string; start: number; end: number }>;
    estimated: boolean;
  }>;

  /**
   * Generate speech in streaming mode (emits chunk events).
   * @param text - Text to convert to speech
   * @param options - Generation options (sid, speed, referenceAudio, referenceText, numSteps, silenceScale, extra)
   */
  generateTtsStream(text: string, options: Object): Promise<void>;

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

  // ==================== Helper - Assets ====================

  /**
   * Resolve model path based on configuration.
   * Handles asset paths, file system paths, and auto-detection.
   * Returns an absolute path that can be used by native code.
   *
   * @param config - Object with 'type' ('asset' | 'file' | 'auto') and 'path' (string)
   */
  resolveModelPath(config: { type: string; path: string }): Promise<string>;

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
   *   const result = await initializeStt(path);
   *   if (result.success) {
   *     console.log(`Found models in ${model.folder}:`, result.detectedModels);
   *   }
   * }
   * ```
   */
  listAssetModels(): Promise<
    Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>
  >;

  /**
   * List model folders under a specific filesystem path.
   * When recursive is true, returns relative folder paths under the base path.
   */
  listModelsAtPath(
    path: string,
    recursive: boolean
  ): Promise<Array<{ folder: string; hint: 'stt' | 'tts' | 'unknown' }>>;

  /**
   * **Play Asset Delivery (PAD):** Returns the filesystem path to the models directory
   * of an Android asset pack, or null if the pack is not available (e.g. not installed).
   * Use this to list and load models that are delivered via PAD instead of bundled app assets.
   */
  getAssetPackPath(packName: string): Promise<string | null>;

  // ==================== Helper - Extraction ====================

  /**
   * Extract a .tar.bz2 archive to a target folder.
   * Returns { success, path } or { success, reason }.
   */
  extractTarBz2(
    sourcePath: string,
    targetPath: string,
    force: boolean
  ): Promise<{
    success: boolean;
    path?: string;
    sha256?: string;
    reason?: string;
  }>;

  /**
   * Cancel any in-progress tar.bz2 extraction.
   */
  cancelExtractTarBz2(): Promise<void>;

  /**
   * Compute SHA-256 of a file and return the hex digest.
   */
  computeFileSha256(filePath: string): Promise<string>;

  // ==================== Helper - Audio conversion ====================

  /**
   * Convert arbitrary audio file to requested format (e.g. "mp3", "flac", "wav").
   * Requires FFmpeg prebuilts when called on Android.
   * For MP3 (libshine), outputSampleRateHz can be 32000, 44100, or 48000; 0 or omitted = 44100.
   * WAV output is always 16 kHz mono (sherpa-onnx). Resolves when conversion succeeds, rejects with an error message on failure.
   */
  convertAudioToFormat(
    inputPath: string,
    outputPath: string,
    format: string,
    outputSampleRateHz?: number
  ): Promise<void>;

  /**
   * Convert any supported audio file to WAV 16 kHz mono 16-bit PCM.
   * Requires FFmpeg prebuilts when called on Android.
   */
  convertAudioToWav16k(inputPath: string, outputPath: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
