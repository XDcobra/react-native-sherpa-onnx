import { TurboModuleRegistry, type TurboModule } from 'react-native';

/** Unified shape for all acceleration backends (QNN, NNAPI, XNNPACK, Core ML). */
export type AccelerationSupport = {
  providerCompiled: boolean;
  hasAccelerator: boolean;
  canInit: boolean;
};

/** Result from unified archive extraction (path or asset stream). */
export type ExtractArchiveResult = {
  success: boolean;
  /** True when extraction stopped due to cancel (resume with skipEntries = lastEntryIndex + 1). */
  paused: boolean;
  lastEntryIndex: number;
  lastEntryPath: string;
  bytesExtracted: number;
  path?: string;
  sha256?: string;
  reason?: string;
};

export interface Spec extends TurboModule {
  /**
   * Test method to verify sherpa-onnx native library is loaded.
   */
  testSherpaInit(): Promise<string>;

  // ==================== STT Methods ====================

  /**
   * Initialize Speech-to-Text (STT) with model directory.
   * Expects an absolute path (use resolveModelPath first for asset/file paths).
   * @param instanceId - Unique ID for this engine instance (from createSTT)
   * @param modelDir - Absolute path to model directory
   * @param preferInt8 - Optional: true = prefer int8 models, false = prefer regular models, undefined = try int8 first (default)
   * @param modelType - Optional: explicit model type ('transducer', 'nemo_transducer', 'paraformer', 'nemo_ctc', 'wenet_ctc', 'sense_voice', 'zipformer_ctc', 'whisper', 'funasr_nano', 'qwen3_asr', 'cohere_transcribe', 'fire_red_asr', 'moonshine', 'moonshine_v2', 'dolphin', 'canary', 'omnilingual', 'medasr', 'telespeech_ctc', 'auto'), undefined = auto (default)
   * @param debug - Optional: enable debug logging in native layer and sherpa-onnx (default: false)
   * @param hotwordsFile - Optional: path to hotwords file (OfflineRecognizerConfig)
   * @param hotwordsScore - Optional: hotwords score (default in Kotlin 1.5)
   * @param numThreads - Optional: number of threads for inference (default in Kotlin: 1)
   * @param provider - Optional: provider string e.g. 'cpu' (stored in config only)
   * @param ruleFsts - Optional: path(s) to rule FSTs for ITN (comma-separated)
   * @param ruleFars - Optional: path(s) to rule FARs for ITN (comma-separated)
   * @param dither - Optional: dither for feature extraction. **Android:** applied. **iOS:** ignored (native API does not expose it)
   * @param modelOptions - Optional: model-specific options (whisper, senseVoice, canary, funasrNano, qwen3Asr, cohereTranscribe). Only the block for the loaded model type is applied.
   * @param modelingUnit - Optional: 'cjkchar' | 'bpe' | 'cjkchar+bpe' for hotwords tokenization (OfflineModelConfig.modelingUnit)
   * @param bpeVocab - Optional: path to BPE vocab file (OfflineModelConfig.bpeVocab), used when modelingUnit is bpe or cjkchar+bpe
   * @returns Object with success boolean, array of detected models (each with type and modelDir), and optional error when success is false.
   */
  initializeStt(
    instanceId: string,
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
    /** Present when success is false (native structured failure). */
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    decodingMethod?: string;
  }>;

  /**
   * Detect STT model type and structure without initializing the recognizer.
   * Uses the same native detection logic as initializeStt.
   * @param modelDir - Absolute path to extracted model directory, or empty string for asset-name-only detection.
   * @param assetName - Release asset stem / folder basename (e.g. sherpa-onnx-whisper-tiny); null/empty when scanning modelDir only.
   * @param modelType - Optional: explicit type or 'auto' (default)
   * @param preferInt8 - Optional: true = prefer int8, false = prefer regular, undefined = try int8 first
   * @param debug - Optional: enable verbose native logging
   * @returns Object with unified detect fields plus STT-specific `isHardwareSpecificUnsupported`.
   */
  detectSttModel(
    modelDir: string,
    assetName: string | null,
    modelType?: string | null,
    preferInt8?: boolean,
    debug?: boolean
  ): Promise<{
    success: boolean;
    /** Present when success is false (or native included a message). */
    error?: string;
    /** True when detection failed because the model targets unsupported hardware (RK35xx, Ascend, CANN). Use to show a specific message or block init. */
    isHardwareSpecificUnsupported?: boolean;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    /** Raw heuristic language tags from asset/folder name (catalog). */
    languages?: string[];
    /** fp16, int8, int8-quantized, unknown — from name heuristics. */
    quantization?: string;
    /** Optional trace strings from native (see DetectionSource in src/types/modelDetect.ts). */
    detectionSources?: string[];
  }>;

  // ==================== Offline STT (by-reference) ====================

  /**
   * Transcribe from a pipeline offline audio buffer. Returns metadata-only ref; use getters for large data.
   * @param instanceId - STT engine instance ID
   * @param bufferId - Offline audio buffer handle (off_…)
   */
  transcribe(
    instanceId: string,
    bufferId: string
  ): Promise<{
    success: boolean;
    resultId?: number;
    sampleRate?: number;
    textLength?: number;
    tokenCount?: number;
    timestampCount?: number;
    durationCount?: number;
    hasLang?: boolean;
    hasEmotion?: boolean;
    hasEvent?: boolean;
    error?: string;
  }>;

  // ==================== STT Result Getters (by-reference) ====================

  getSttResultText(instanceId: string, resultId: number): Promise<string>;

  getSttResultTokens(
    instanceId: string,
    resultId: number,
    start: number,
    maxCount: number
  ): Promise<string[]>;

  getSttResultTimestamps(
    instanceId: string,
    resultId: number,
    start: number,
    maxCount: number
  ): Promise<number[]>;

  getSttResultDurations(
    instanceId: string,
    resultId: number,
    start: number,
    maxCount: number
  ): Promise<number[]>;

  getSttResultLang(instanceId: string, resultId: number): Promise<string>;
  getSttResultEmotion(instanceId: string, resultId: number): Promise<string>;
  getSttResultEvent(instanceId: string, resultId: number): Promise<string>;

  releaseSttResult(instanceId: string): Promise<void>;

  /**
   * Update recognizer config at runtime.
   */
  setSttConfig(instanceId: string, options: Object): Promise<void>;

  /**
   * Release STT resources.
   */
  unloadStt(instanceId: string): Promise<void>;

  // ==================== Online (streaming) STT Methods ====================

  /**
   * Initialize OnlineRecognizer for streaming STT (single options object to avoid iOS TurboModule marshalling crash with many args).
   * @param instanceId - Unique ID for this engine instance (from createStreamingSTT)
   * @param options - All init options (modelDir, modelType, enableEndpoint, decodingMethod, maxActivePaths, and optional endpoint/rule params).
   *   `options.dither`: **Android** only; **iOS** ignores it (native `FeatureConfig` has no dither field).
   * @returns `{ success: true }` on success, or `{ success: false, error?: string }` on structured native failure.
   */
  initializeOnlineSttWithOptions(
    instanceId: string,
    options: {
      modelDir: string;
      modelType: string;
      enableEndpoint?: boolean;
      decodingMethod?: string;
      maxActivePaths?: number;
      hotwordsFile?: string;
      hotwordsScore?: number;
      numThreads?: number;
      provider?: string;
      ruleFsts?: string;
      ruleFars?: string;
      /** Feature dither. Android: applied. iOS: ignored. */
      dither?: number;
      blankPenalty?: number;
      debug?: boolean;
      rule1MustContainNonSilence?: boolean;
      rule1MinTrailingSilence?: number;
      rule1MinUtteranceLength?: number;
      rule2MustContainNonSilence?: boolean;
      rule2MinTrailingSilence?: number;
      rule2MinUtteranceLength?: number;
      rule3MustContainNonSilence?: boolean;
      rule3MinTrailingSilence?: number;
      rule3MinUtteranceLength?: number;
    }
  ): Promise<{ success: boolean; error?: string }>;

  /** Create a new stream for the given OnlineRecognizer instance. */
  createSttStream(
    instanceId: string,
    streamId: string,
    hotwords?: string
  ): Promise<void>;

  /** Feed PCM samples to a streaming STT stream. */
  acceptSttWaveform(
    streamId: string,
    samples: number[],
    sampleRate: number
  ): Promise<void>;

  /** Signal end of input for a streaming STT stream. */
  sttStreamInputFinished(streamId: string): Promise<void>;

  /** Run decoding on the stream (call when isSttStreamReady is true). */
  decodeSttStream(streamId: string): Promise<void>;

  /** True if the stream has enough audio to decode. */
  isSttStreamReady(streamId: string): Promise<boolean>;

  /** Get current partial or final result. Text-first; no large arrays by default. */
  getSttStreamResult(streamId: string): Promise<{
    text: string;
    isFinal: boolean;
    tokens: string[];
    timestamps: number[];
  }>;

  /** True if endpoint (end of utterance) was detected. */
  isSttStreamEndpoint(streamId: string): Promise<boolean>;

  /** Reset stream state for reuse. */
  resetSttStream(streamId: string): Promise<void>;

  /** Release stream and remove from native state. */
  releaseSttStream(streamId: string): Promise<void>;

  /** Release OnlineRecognizer and all its streams. */
  unloadOnlineStt(instanceId: string): Promise<void>;

  /**
   * Convenience: feed audio, decode while ready, return result and endpoint status in one call.
   */
  processSttAudioChunk(
    streamId: string,
    samples: number[],
    sampleRate: number
  ): Promise<{
    text: string;
    tokens: string[];
    timestamps: number[];
    isEndpoint: boolean;
    isFinal: boolean;
  }>;

  // ==================== Pipeline Audio Buffers ====================

  /**
   * Create an offline audio buffer from a WAV file.
   * Small files are loaded into memory; large files (>10 MB) stay file-backed.
   */
  createOfflineAudioBufferFromFile(
    sourcePath: string,
    targetSampleRateHz?: number,
    forceMono?: boolean
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    sampleRate: number;
    channelCount: number;
    numSamples: number;
    durationMs: number;
  }>;

  /**
   * Create an offline audio buffer from Float32 PCM samples.
   */
  createOfflineAudioBufferFromSamples(
    samples: number[],
    sampleRate: number,
    channelCount?: number
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    sampleRate: number;
    channelCount: number;
    numSamples: number;
    durationMs: number;
  }>;

  /**
   * Create an offline audio buffer from a live buffer.
   * @param liveBufferId - The live buffer to snapshot/convert.
   * @param mode - "fullIfSpooled" (uses spool file if available) or "windowSnapshot" (ring snapshot).
   */
  createOfflineAudioBufferFromLive(
    liveBufferId: string,
    mode?: string
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    sampleRate: number;
    channelCount: number;
    numSamples: number;
    durationMs: number;
  }>;

  /**
   * Create a live audio buffer with a rolling-window ring buffer.
   * @param options.sampleRate - Sample rate in Hz.
   * @param options.windowSeconds - Ring buffer window size in seconds (default: 60).
   * @param options.persistencePath - Optional file path for WAV spool.
   * @param options.persistenceFormat - "wav_pcm_s16le" (default) or "wav_pcm_float".
   * @param options.emitAppendedEvents - If true, emit pipelineLiveAudioChunk when new frames are appended (all producers).
   * @param options.emitAppendedSamples - If true, include Float32 samples in append events (default: true).
   * @param options.appendEventMinIntervalMs - Optional append-event throttle/coalesce interval in ms (default: 0).
   */
  createLiveAudioBuffer(options: {
    sampleRate: number;
    channelCount?: number;
    windowSeconds?: number;
    persistencePath?: string;
    persistenceFormat?: string;
    emitAppendedEvents?: boolean;
    emitAppendedSamples?: boolean;
    appendEventMinIntervalMs?: number;
  }): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    sampleRate: number;
    channelCount: number;
    numSamples: number;
    durationMs: number;
    totalSamplesWritten: number;
    totalSamplesDropped: number;
    hasActiveSpool: boolean;
  }>;

  /**
   * Append Float32 samples to a live audio buffer (recording state only).
   */
  appendSamplesToLiveAudioBuffer(
    liveBufferId: string,
    samples: number[],
    sampleRate: number
  ): Promise<void>;

  /**
   * Append all samples from an offline buffer to a live buffer.
   */
  appendOfflineToLiveAudioBuffer(
    liveBufferId: string,
    offlineBufferId: string
  ): Promise<void>;

  /**
   * Finalize a live audio buffer (recording → finished).
   * No more appends allowed after this. Patches spool WAV header if persistence is active.
   */
  finalizeLiveAudioBuffer(liveBufferId: string): Promise<void>;

  /**
   * Save an offline audio buffer as 16-bit PCM WAV.
   */
  saveOfflineAudioBufferToWav(
    bufferId: string,
    outputPath: string
  ): Promise<void>;

  /**
   * Save a live audio buffer as 16-bit PCM WAV.
   * If spool active and finalized, copies the spool file. Otherwise writes ring snapshot.
   */
  saveLiveAudioBufferToWav(
    liveBufferId: string,
    outputPath: string
  ): Promise<void>;

  /**
   * Get info for any pipeline audio buffer (offline or live).
   */
  getPipelineAudioBufferInfo(bufferId: string): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    sampleRate: number;
    channelCount: number;
    numSamples: number;
    durationMs: number;
    totalSamplesWritten?: number;
    totalSamplesDropped?: number;
    hasActiveSpool?: boolean;
  }>;

  /**
   * Release any pipeline audio buffer (offline or live).
   */
  releasePipelineAudioBuffer(bufferId: string): Promise<void>;

  /**
   * Get a slice of Float32 samples from a live buffer's ring (for debug/export).
   */
  getLiveAudioBufferSamplesSlice(
    liveBufferId: string,
    startFrame: number,
    frameCount: number
  ): Promise<number[]>;

  /**
   * Start microphone capture directly into a live audio buffer (no JS roundtrip).
   * The mic writes resampled Float32 samples directly into the live buffer's ring.
   * `emitToJs` is a compatibility shortcut to force-enable/disable append events for this live buffer.
   */
  startMicToLiveAudioBuffer(
    liveBufferId: string,
    options?: { emitToJs?: boolean }
  ): Promise<void>;

  /**
   * Stop microphone capture to a live audio buffer.
   */
  stopMicToLiveAudioBuffer(): Promise<void>;

  // ==================== TTS Methods ====================

  /**
   * Initialize Text-to-Speech (TTS) with model directory.
   * @param instanceId - Unique ID for this engine instance (from createTTS)
   * @param modelDir - Absolute path to model directory
   * @param modelType - Model type ('vits', 'matcha', 'kokoro', 'kitten', 'pocket', 'zipvoice', 'supertonic', 'auto')
   * @param numThreads - Number of threads for inference (default: 2)
   * @param debug - Enable debug logging (default: false)
   * @param noiseScale - Optional noise scale (VITS/Matcha)
   * @param noiseScaleW - Optional noise scale W (VITS)
   * @param lengthScale - Optional length scale (VITS/Matcha/Kokoro/Kitten)
   * @param ruleFsts - Optional path(s) to rule FSTs for TTS (OfflineTtsConfig)
   * @param ruleFars - Optional path(s) to rule FARs for TTS (OfflineTtsConfig)
   * @param maxNumSentences - Optional max sentences per callback (default: 1)
   * @param silenceScale - Optional silence scale on config (default: 0.2)
   * @param provider - Optional execution provider (e.g. 'cpu', 'coreml', 'xnnpack'; default: 'cpu')
   * @returns Object with success boolean, array of detected models (each with type and modelDir), sampleRate/numSpeakers on success, and optional error when success is false.
   */
  initializeTts(
    instanceId: string,
    modelDir: string,
    modelType: string,
    numThreads: number,
    debug: boolean,
    noiseScale?: number,
    noiseScaleW?: number,
    lengthScale?: number,
    ruleFsts?: string,
    ruleFars?: string,
    maxNumSentences?: number,
    silenceScale?: number,
    provider?: string
  ): Promise<{
    success: boolean;
    /** Present when success is false (native structured failure). */
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    sampleRate: number;
    numSpeakers: number;
  }>;

  /**
   * Detect TTS model type and structure without initializing the engine.
   * Uses the same native file-based detection as initializeTts.
   * For Kokoro/Kitten multi-language models, also returns lexiconLanguageCandidates (e.g. ["default"], ["us-en", "gb-en", "zh"]) from detected lexicon.txt / lexicon-*.txt files.
   * Note: this is the raw native bridge shape; JS facade `tts/detectTtsModel` narrows `modelType` to `TTSModelType`.
   * @param modelDir - Absolute path to extracted model directory, or empty string when using `assetName` only (catalog hints).
   * @param assetName - Release asset stem / folder basename (e.g. vits-piper-en_US-lessac-medium), or null/empty when scanning `modelDir` only.
   * @param modelType - Optional: explicit type or 'auto' (default)
   * @returns Object with success, detectedModels, modelType, optional lexiconLanguageCandidates, optional name-derived languages/quantization/sizeTier, and optional detectionSources.
   */
  detectTtsModel(
    modelDir: string,
    assetName: string | null,
    modelType?: string | null
  ): Promise<{
    success: boolean;
    /** Present when success is false (or native included a message). */
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    /** Language ids from detected lexicon files (e.g. "default" for lexicon.txt, "us-en", "zh" from lexicon-us-en.txt, lexicon-zh.txt). Present for Kokoro/Kitten when multiple or single lexicon files are found; use for language selection UI. */
    lexiconLanguageCandidates?: string[];
    /** Raw heuristic language tags from asset/folder name (catalog); not from lexicon files. JS `detectTtsModel` / download catalog normalize these for the public API. */
    languages?: string[];
    /** fp16, int8, int8-quantized, unknown — from name heuristics. */
    quantization?: string;
    /** tiny, small, medium, large, unknown — from name heuristics. */
    sizeTier?: string;
    /** Optional trace strings from native (see DetectionSource in src/types/modelDetect.ts). */
    detectionSources?: string[];
  }>;

  /**
   * Update TTS model parameters by re-initializing with stored config.
   * @param instanceId - Unique ID for this engine instance
   * @param noiseScale - Optional noise scale override
   * @param noiseScaleW - Optional noise scale W override
   * @param lengthScale - Optional length scale override
   * @returns Object with success, detectedModels, sampleRate, numSpeakers on success, and optional error when success is false.
   */
  updateTtsParams(
    instanceId: string,
    noiseScale?: number | null,
    noiseScaleW?: number | null,
    lengthScale?: number | null
  ): Promise<{
    success: boolean;
    /** Present when success is false (native structured failure). */
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    sampleRate: number;
    numSpeakers: number;
  }>;

  /**
   * Generate speech from text. Returns metadata only (no PCM samples).
   * Use getTtsSamples() to retrieve PCM from the native sink.
   * @param instanceId - Unique ID for this engine instance
   * @param text - Text to convert to speech
   * @param options - Generation options: `sid`, `speed`, `silenceScale`, `numSteps`, `extra`.
   *   Voice cloning (iOS & Android): `referenceAudio` + `referenceSampleRate` for Zipvoice/Pocket only; Zipvoice also needs non-empty `referenceText`.
   * @returns Object with { sampleRate, numSamples, generation }
   */
  generateTts(
    instanceId: string,
    text: string,
    options: Object
  ): Promise<{
    sampleRate: number;
    numSamples: number;
    generation: number;
  }>;

  /**
   * Generate speech with subtitle/timestamp metadata. Returns metadata only (no PCM samples).
   * Use getTtsSamples() to retrieve PCM from the native sink.
   * @param instanceId - Unique ID for this engine instance
   * @param text - Text to convert to speech
   * @param options - Same as {@link generateTts} options plus subtitle options (`subtitleMode`, `subtitleGranularity`).
   * @returns Object with sampleRate, numSamples, generation, subtitles, and timingMode
   */
  generateTtsWithTimestamps(
    instanceId: string,
    text: string,
    options: Object
  ): Promise<{
    sampleRate: number;
    numSamples: number;
    generation: number;
    subtitles: Array<{ text: string; start: number; end: number }>;
    timingMode: string;
    /** Present for estimated subtitle mode (one sample-count per sentence chunk). */
    segmentSampleCounts?: number[];
  }>;

  /**
   * Retrieve PCM samples from the native sink for a given TTS generation.
   * @param instanceId - TTS engine instance ID
   * @param generation - Generation number from generateTts/generateTtsWithTimestamps
   * @returns Object with { samples: number[], sampleRate: number }
   */
  getTtsSamples(
    instanceId: string,
    generation: number
  ): Promise<{
    samples: number[];
    sampleRate: number;
  }>;

  /**
   * Save TTS audio directly from the native sink (no JS PCM round-trip).
   * @param instanceId - TTS engine instance ID
   * @param generation - Generation number from generateTts
   * @param destinationType - 'file' or 'androidContent'
   * @param pathOrDirectoryUri - Output path or SAF directory URI
   * @param filename - Filename for androidContent destination
   * @param format - Output format (wav, mp3, flac, etc.)
   * @param outputSampleRateHz - Encoder sample rate hint; 0 for defaults
   */
  saveTtsAudioFromSink(
    instanceId: string,
    generation: number,
    destinationType: string,
    pathOrDirectoryUri: string,
    filename: string,
    format: string,
    outputSampleRateHz: number
  ): Promise<string>;

  /**
   * Play PCM from the native batch sink through the device speaker.
   * @param instanceId - TTS engine instance ID
   * @param generation - Expected sink generation (stale check)
   * @param sampleRate - Override sample rate (0 = use sink rate)
   */
  playTtsFromSink(
    instanceId: string,
    generation: number,
    sampleRate: number
  ): Promise<{ playerId: string }>;

  // ==================== Alignment / Subtitle Methods ====================

  /**
   * Read audio duration/sample metrics for common formats (WAV fast path + decoder/metadata fallback).
   */
  getAudioDuration(audioPath: string): Promise<{
    sampleRate: number;
    totalSamples: number;
  }>;

  /**
   * Standalone alignment from audio path (all modes).
   */
  alignTextToAudioFromPath(
    text: string,
    audioPath: string,
    mode: 'proportional' | 'estimated' | 'accurate',
    granularity: 'sentence' | 'word' | 'character',
    options?: Object
  ): Promise<{
    subtitles: Array<{ text: string; start: number; end: number }>;
    timingMode: string;
  }>;

  /**
   * Standalone alignment from in-memory PCM (all modes).
   */
  alignTextToAudioFromPcm(
    text: string,
    samples: number[],
    sampleRate: number,
    mode: 'proportional' | 'estimated' | 'accurate',
    granularity: 'sentence' | 'word' | 'character',
    options?: Object
  ): Promise<{
    subtitles: Array<{ text: string; start: number; end: number }>;
    timingMode: string;
  }>;

  /**
   * Sink-based alignment from generated TTS audio (zero PCM round-trip for accurate mode).
   */
  alignTextToTtsSink(
    generatedAudio: Object,
    text: string,
    mode: 'proportional' | 'estimated' | 'accurate',
    granularity: 'sentence' | 'word' | 'character',
    options?: Object
  ): Promise<{
    subtitles: Array<{ text: string; start: number; end: number }>;
    timingMode: string;
  }>;

  detectAlignmentModel(
    modelDir: string,
    modelType?: string
  ): Promise<{
    success: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    paths?: {
      model?: string;
    };
    /** Raw heuristic language tags from folder name (catalog). */
    languages?: string[];
    /** fp16, int8, int8-quantized, unknown — from name heuristics. */
    quantization?: string;
    /** Optional trace strings from native (see DetectionSource). */
    detectionSources?: string[];
  }>;

  // ==================== Online (streaming) TTS Methods ====================

  /**
   * Generate speech in streaming mode (emits chunk events).
   * @param instanceId - Unique ID for this engine instance
   * @param requestId - Unique ID for this generation (included in chunk/end/error events for routing)
   * @param text - Text to convert to speech
   * @param options - Same shape as batch TTS; reference streaming is **Pocket-only** (Zipvoice cloning uses non-streaming generate).
   */
  generateTtsStream(
    instanceId: string,
    requestId: string,
    text: string,
    options: Object
  ): Promise<void>;

  /**
   * Generate speech in streaming mode and write directly to file in native.
   * Emits `ttsStreamFileEnd` / `ttsStreamFileError` and optionally `ttsStreamChunk`.
   */
  generateTtsStreamToFile(
    instanceId: string,
    requestId: string,
    text: string,
    options: Object,
    fileOptions: Object
  ): Promise<void>;

  /**
   * Cancel an ongoing streaming TTS generation.
   * @param instanceId - Unique ID for this engine instance
   */
  cancelTtsStream(instanceId: string): Promise<void>;

  /**
   * Create a standalone PCM player session.
   * @param playerId - Unique session ID (generated by JS)
   * @param sampleRate - Sample rate in Hz
   * @param channels - Number of channels (1 = mono)
   * @param feed - 'js' or 'native'
   * @param ttsInstanceId - Optional TTS engine binding (null = standalone)
   */
  createPcmPlayer(
    playerId: string,
    sampleRate: number,
    channels: number,
    feed: string,
    ttsInstanceId: string | null
  ): Promise<void>;

  /**
   * Write float PCM samples to a player session.
   * Rejects if feed is 'native' or player not found.
   * @param playerId - Player session ID
   * @param samples - Float PCM [-1, 1]
   */
  writePcmChunk(playerId: string, samples: number[]): Promise<void>;

  /**
   * Pause a PCM player session. Buffered samples are retained.
   * @param playerId - Player session ID
   */
  pausePcmPlayer(playerId: string): Promise<void>;

  /**
   * Resume a paused PCM player session.
   * @param playerId - Player session ID
   */
  resumePcmPlayer(playerId: string): Promise<void>;

  /**
   * Destroy a PCM player session and release native resources.
   * @param playerId - Player session ID
   */
  destroyPcmPlayer(playerId: string): Promise<void>;

  /**
   * Get the sample rate of the initialized TTS model.
   * @param instanceId - Unique ID for this engine instance
   * @returns Sample rate in Hz
   */
  getTtsSampleRate(instanceId: string): Promise<number>;

  /**
   * Get the number of speakers/voices available in the model.
   * @param instanceId - Unique ID for this engine instance
   * @returns Number of speakers (0 or 1 for single-speaker models)
   */
  getTtsNumSpeakers(instanceId: string): Promise<number>;

  /**
   * Release TTS resources.
   * @param instanceId - Unique ID for this engine instance
   */
  unloadTts(instanceId: string): Promise<void>;

  // ==================== Speech Enhancement Methods ====================

  detectEnhancementModel(
    modelDir: string,
    assetName: string | null,
    modelType?: string | null
  ): Promise<{
    success: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    languages?: string[];
    quantization?: string;
    detectionSources?: string[];
  }>;

  initializeEnhancement(
    instanceId: string,
    modelDir: string,
    modelType?: string,
    numThreads?: number,
    provider?: string,
    debug?: boolean
  ): Promise<{
    success: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    sampleRate?: number;
  }>;

  enhanceFile(
    instanceId: string,
    inputPath: string,
    outputPath?: string
  ): Promise<{ samples: number[]; sampleRate: number }>;

  enhanceSamples(
    instanceId: string,
    samples: number[],
    sampleRate: number
  ): Promise<{ samples: number[]; sampleRate: number }>;

  getEnhancementSampleRate(instanceId: string): Promise<number>;

  unloadEnhancement(instanceId: string): Promise<void>;

  initializeOnlineEnhancement(
    instanceId: string,
    modelDir: string,
    modelType?: string,
    numThreads?: number,
    provider?: string,
    debug?: boolean
  ): Promise<{
    success: boolean;
    error?: string;
    sampleRate?: number;
    frameShiftInSamples?: number;
  }>;

  feedEnhancementSamples(
    instanceId: string,
    samples: number[],
    sampleRate: number
  ): Promise<{ samples: number[]; sampleRate: number }>;

  flushOnlineEnhancement(
    instanceId: string
  ): Promise<{ samples: number[]; sampleRate: number }>;

  resetOnlineEnhancement(instanceId: string): Promise<void>;

  unloadOnlineEnhancement(instanceId: string): Promise<void>;

  /**
   * Save TTS audio (mono float PCM) to a file path or Android SAF directory.
   * @param destinationType - `'file'` = `pathOrDirectoryUri` is the full output file path; `'androidContent'` = directory tree URI + `filename`
   * @param pathOrDirectoryUri - Absolute file path (when `file`) or SAF directory URI (when `androidContent`)
   * @param filename - Used when `androidContent`; ignored / empty when `file`
   * @param format - Output container/codec hint: `wav` (default behavior), `mp3`, `flac`, `m4a`, `opus`, … (same as convertAudioToFormat; requires FFmpeg when not WAV)
   * @param outputSampleRateHz - Encoder hint (e.g. MP3 32000/44100/48000); use 0 for defaults
   */
  saveTtsAudioFromPCM(
    samples: number[],
    sampleRate: number,
    destinationType: string,
    pathOrDirectoryUri: string,
    filename: string,
    format: string,
    outputSampleRateHz: number
  ): Promise<string>;

  // ==================== File / persistence (shared) ====================

  /**
   * Save a text file via Android SAF directory URI, or a regular directory path on iOS.
   * @param text - Text content to write
   * @param directoryUri - Directory content URI (tree or document) on Android; file URL or path on iOS
   * @param filename - Desired file name (e.g. note.txt)
   * @param mimeType - MIME type (e.g. text/plain)
   * @returns The content URI of the saved file (Android) or file path (iOS)
   */
  saveTextToContentUri(
    text: string,
    directoryUri: string,
    filename: string,
    mimeType: string
  ): Promise<string>;

  /**
   * Copy a local file into a document under a SAF directory URI (format-agnostic; Android only).
   * @param filePath - Absolute path to an existing file on disk
   * @param directoryUri - SAF directory tree or document URI
   * @param filename - Display name for the new document
   * @param mimeType - MIME type for the created document
   * @returns The content URI of the created document
   */
  copyFileToContentUri(
    filePath: string,
    directoryUri: string,
    filename: string,
    mimeType: string
  ): Promise<string>;

  /**
   * Copy a content URI (or file path) to an app cache file for native consumers.
   * @param fileUri - content:// URI or file path
   * @param filename - Desired cache file name
   * @returns Absolute file path to the cached copy
   */
  copyContentUriToCache(fileUri: string, filename: string): Promise<string>;

  /**
   * Open the system share sheet for an audio file (file path or content URI).
   * @param fileUri - File path or content URI
   * @param mimeType - MIME type (e.g. audio/wav)
   */
  shareAudioFile(fileUri: string, mimeType: string): Promise<void>;

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

  /**
   * Read the contents of a text file from the bundled assets (Android) or main bundle (iOS).
   * @param assetPath The relative path to the asset file (e.g., 'model_licenses/asr-models-license-status.csv')
   * @returns Resolves with the string content of the file or rejects if the file cannot be read.
   */
  readAssetFileAsUtf8(assetPath: string): Promise<string>;

  // ==================== Helper - Extraction ====================

  /**
   * Extract a tar archive (.tar.bz2, .tar.zst, etc.) from a filesystem path. Native layer auto-detects format.
   *
   * @param skipEntries - 0 for a fresh run; for resume, pass `lastEntryIndex + 1` from a paused result.
   * @param operationId - Unique ID for this extraction; use with `cancelExtraction` and progress events.
   *
   * **Android:** When `showNotificationsEnabled` is true (default), a system notification shows progress.
   * **iOS:** Notification parameters are accepted but have no effect.
   */
  extractArchive(
    sourcePath: string,
    targetPath: string,
    force: boolean,
    skipEntries: number,
    operationId: string,
    showNotificationsEnabled?: boolean,
    notificationTitle?: string,
    notificationText?: string
  ): Promise<ExtractArchiveResult>;

  /**
   * Extract from an Android APK asset path (PAD APK_ASSETS). Not supported on iOS (resolves to failure).
   * Same `skipEntries` / `operationId` semantics as `extractArchive`.
   */
  extractArchiveFromAsset(
    assetPath: string,
    targetPath: string,
    force: boolean,
    skipEntries: number,
    operationId: string,
    showNotificationsEnabled?: boolean,
    notificationTitle?: string,
    notificationText?: string
  ): Promise<ExtractArchiveResult>;

  /**
   * Cancel an in-progress extraction for the given `operationId`.
   */
  cancelExtraction(operationId: string): Promise<void>;

  /**
   * List asset paths of .tar.zst and .tar.bz2 archives in a PAD pack when stored as APK_ASSETS.
   * Android only; returns [] when pack is not available or not APK_ASSETS. Used by getBundledArchives.
   */
  listBundledArchiveAssetPaths(packName: string): Promise<string[]>;

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

  /**
   * Decode an audio file to mono float samples in [-1, 1] and the effective sample rate.
   * Supports the same inputs as convertAudioToFormat (file paths and Android content:// URIs).
   * On Android, non-WAV formats require FFmpeg prebuilts; WAV may use a fast path via WaveReader.
   * @param targetSampleRateHz - If > 0, resample to this rate; if 0 or omitted, keep the decoded stream rate.
   */
  decodeAudioFileToFloatSamples(
    inputPath: string,
    targetSampleRateHz?: number
  ): Promise<{ samples: number[]; sampleRate: number }>;

  // ==================== Execution Provider Methods ====================

  /**
   * Return the list of available ONNX Runtime execution providers (e.g. "CPU", "NNAPI", "QNN", "XNNPACK").
   * Requires the ORT Java bridge (libonnxruntime4j_jni.so + OrtEnvironment class) from the onnxruntime AAR.
   */
  getAvailableProviders(): Promise<string[]>;

  // ==================== Acceleration support (unified format) ====================

  /**
   * Unified acceleration support: providerCompiled (ORT EP built in), hasAccelerator (NPU/ANE present), canInit (session with EP works).
   * All get*Support methods return this shape. Optional modelBase64: if omitted, SDK uses embedded test model for canInit.
   */
  getQnnSupport(modelBase64?: string): Promise<AccelerationSupport>;
  /** Device SoC model string (e.g. SM8850 on Android 12+). Null if not available. isSupported: true when SoC is SM8xxx (supported for QNN). */
  getDeviceQnnSoc(): Promise<{ soc: string | null; isSupported: boolean }>;
  getNnapiSupport(modelBase64?: string): Promise<AccelerationSupport>;
  getXnnpackSupport(modelBase64?: string): Promise<AccelerationSupport>;
  getCoreMlSupport(modelBase64?: string): Promise<AccelerationSupport>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
