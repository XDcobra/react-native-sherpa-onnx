import { TurboModuleRegistry, type TurboModule } from 'react-native';
import type { AccelerationSupport } from './provider';
import type { ExtractArchiveResult } from './extraction/types';

export interface Spec extends TurboModule {
  /**
   * Test method to verify sherpa-onnx native library is loaded.
   */
  testSherpaInit(): Promise<string>;

  /**
   * Install JSI bindings for high-performance sample transport.
   * Normally auto-installed during module init. Exposed as fallback.
   */
  installJSI(): boolean;

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
    /** True when the model's online-streaming compatibility has been confirmed by the native guard (or heuristically inferred in name-only mode). */
    isStreaming?: boolean;
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
   * Transcribe from a pipeline offline audio buffer into an offline text buffer.
   * The text buffer is populated with the recognition result.
   * @param instanceId - STT engine instance ID
   * @param bufferId - Offline audio buffer handle (off_…)
   * @param textOutBufferId - Offline text buffer handle (txt_off_…) to write result into
   */
  transcribe(
    instanceId: string,
    bufferId: string,
    textOutBufferId: string
  ): Promise<void>;

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

  /** Start native streaming STT pipeline: live audio buffer -> live text buffer. */
  startSttPipeline(
    instanceId: string,
    audioInLiveBufferId: string,
    textOutLiveBufferId: string,
    chunkSize?: number
  ): Promise<{ pipelineId: string }>;

  /** Release OnlineRecognizer and stop any active STT pipeline for this instance. */
  unloadOnlineStt(instanceId: string): Promise<void>;

  /**
   * Start a live-offline STT pipeline: a segmentation engine drives the live audio buffer,
   * and the offline recognizer processes each committed speech segment.
   * Returns a pipelineId compatible with stopStreamingPipeline / flushStreamingPipeline / etc.
   */
  startSttOfflineLivePipeline(
    instanceId: string,
    audioInLiveBufferId: string,
    textOutLiveBufferId: string,
    options: {
      attachedSegmentationEngineId: string;
      segmentLiveBufferId: string;
      chunkSize?: number;
    }
  ): Promise<{ pipelineId: string }>;

  /**
   * Start a live-offline Enhancement pipeline.
   * Restricts evaluator to `continuous_frames`.
   */
  startEnhancementOfflineLivePipeline(
    instanceId: string,
    audioInLiveBufferId: string,
    audioOutLiveBufferId: string,
    options: {
      attachedSegmentationEngineId: string;
      segmentLiveBufferId: string;
    }
  ): Promise<{ pipelineId: string }>;

  // ==================== Pipeline Audio Buffers ====================

  /**
   * Decode an audio file into an offline audio buffer.
   * Uses AudioDecodeSession (FFmpeg + WAV fast path).
   * @param source - Serialized FileSource (ReadableMap with `kind` discriminator)
   * @param targetSampleRateHz - 0 = keep source rate, >0 = force that rate.
   *                             Public API passes 16000 when omitted.
   * @param forceMono - true = downmix to mono
   * @param operationId - For progress events + cancellation
   */
  decodeFileToOfflineBuffer(
    source: Object,
    targetSampleRateHz: number,
    forceMono: boolean,
    operationId: string
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
   * Transfer a finalized live audio buffer spool into an offline buffer without copying.
   * The source live buffer becomes invalidated after successful transfer.
   */
  transferOfflineAudioBufferFromLive(
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
   * Create an empty offline audio buffer as output target (e.g. for TTS synthesis).
   * The buffer starts unpopulated; native synthesis fills it exactly once.
   * @param sampleRate - Expected sample rate (must match model output rate for TTS).
   * @param channelCount - Channel count (only 1/mono supported).
   */
  createEmptyOfflineAudioBuffer(
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
   * Populate an existing empty offline audio buffer exactly once by adopting
   * storage from another offline audio buffer.
   *
   * The source buffer is invalidated/consumed after successful adoption.
   */
  populateOfflineAudioBufferIfEmpty(
    targetBufferId: string,
    sourceBufferId: string,
    options?: Object
  ): Promise<void>;

  /**
   * Create an empty live audio buffer with a rolling-window ring buffer.
   * @param options.sampleRate - Sample rate in Hz. Public API defaults to 16000 when omitted.
   * @param options.ringSeconds - Ring buffer window size in seconds (default: 60).
   * @param options.retentionMode - Retention mode: 'auto' | 'session' | 'maxSeconds' | 'path' | 'none'.
   *                                  ('auto'/'maxSeconds' currently do not enforce trim yet.)
   * @param options.retentionSeconds - Retention seconds for 'maxSeconds' mode (validated when provided).
   * @param options.retentionPath - Explicit path for spool file.
   * @param options.emitAppendedEvents - If true, emit pipelineLiveAudioChunk when new frames are appended (all producers).
   * @param options.appendEventMinIntervalMs - Optional append-event throttle/coalesce interval in ms (default: 0).
   */
  createEmptyLiveAudioBuffer(options: {
    sampleRate: number;
    channelCount?: number;
    ringSeconds?: number;
    retentionMode?: string;
    retentionSeconds?: number;
    retentionPath?: string;
    retentionTrim?: string;
    retentionTrimMaxSeconds?: number;
    emitAppendedEvents?: boolean;
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
    ringEvictedSamples: number;
    hasActiveSpool: boolean;
  }>;

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
    ringEvictedSamples?: number;
    hasActiveSpool?: boolean;
  }>;

  /**
   * Release any pipeline audio buffer (offline or live).
   */
  releasePipelineAudioBuffer(bufferId: string): Promise<void>;

  /**
   * Start microphone capture directly into a live audio buffer (no JS roundtrip).
   * The mic writes resampled Float32 samples directly into the live buffer's ring.
   * `emitToJs` is a compatibility shortcut to force-enable/disable append events for this live buffer.
   */
  startMicToLiveAudioBuffer(
    liveBufferId: string,
    options?: { emitToJs?: boolean }
  ): Promise<void>;

  /** List available input devices for microphone capture routing. */
  listAvailableInputDevices(): Promise<
    Array<{
      id: string;
      name: string;
      kind: string;
      selected: boolean;
      default: boolean;
      canSelect: boolean;
    }>
  >;

  /**
   * Stop microphone capture to a live audio buffer.
   */
  stopMicToLiveAudioBuffer(): Promise<void>;

  // ==================== File Ingest to Live Buffer ====================

  /** Start streaming file decode into an existing live buffer.
   *  targetSampleRateHz: 0 = keep source rate, >0 = force that rate.
   *  Public API passes 16000 when omitted.
   */
  startFileIngestToLiveBuffer(
    liveBufferId: string,
    source: Object,
    targetSampleRateHz: number,
    forceMono: boolean,
    autoFinalize: boolean,
    backpressure: string,
    operationId: string
  ): Promise<{ ingestId: string }>;

  /** Query file ingest status. */
  getFileIngestStatus(ingestId: string): Promise<{
    isRunning: boolean;
    framesIngested: number;
    totalFramesEstimate: number;
    percent: number;
    error?: string;
  }>;

  /** Cancel a running decode operation (offline or ingest). */
  cancelDecode(operationId: string): Promise<void>;

  // ==================== Pipeline Text Buffers ====================

  /**
   * Create an empty offline text buffer as output target for offline STT.
   */
  createEmptyOfflineTextBuffer(): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    utf16Length: number;
    tokenCount: number;
    timestampCount: number;
    durationCount: number;
    hasLang: boolean;
    hasEmotion: boolean;
    hasEvent: boolean;
  }>;

  /**
   * Create an offline text buffer from a live text buffer (snapshot or finalized).
   * @param liveBufferId - Live text buffer handle
   * @param mode - "fullIfSpooled" or "windowSnapshot"
   */
  createOfflineTextBufferFromLive(
    liveBufferId: string,
    mode?: string
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    utf16Length: number;
    tokenCount: number;
    timestampCount: number;
    durationCount: number;
    hasLang: boolean;
    hasEmotion: boolean;
    hasEvent: boolean;
  }>;

  /**
   * Create an offline text buffer pre-populated with the given text.
   * Used as TTS input source for direct text-to-speech synthesis.
   * @param text - The text content to populate the buffer with.
   * @param options - Optional metadata (lang, emotion, event).
   */
  createOfflineTextBufferFromText(
    text: string,
    options?: Object
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    utf16Length: number;
    tokenCount: number;
    timestampCount: number;
    durationCount: number;
    hasLang: boolean;
    hasEmotion: boolean;
    hasEvent: boolean;
  }>;

  /**
   * Populate an existing empty offline text buffer exactly once.
   * Rejects when the buffer does not exist or was already populated.
   */
  populateOfflineTextBufferIfEmpty(
    bufferId: string,
    text: string,
    options?: Object
  ): Promise<void>;

  /**
   * Create a live text buffer for streaming/incremental text.
   */
  createLiveTextBuffer(options: {
    windowMaxChars?: number;
    maxSegments?: number;
    spoolingMode?: string;
    spoolingPath?: string;
    spoolingTemporary?: boolean;
    spoolingThresholdBytes?: number;
    emitPartialEvents?: boolean;
    partialEventMinIntervalMs?: number;
  }): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    totalCharsWritten: number;
    revision: number;
    segmentCount: number;
    spoolMode?: string;
    spoolEnabled?: boolean;
    spoolReady?: boolean;
    spoolBytes?: number;
    spoolPath?: string;
  }>;

  /**
   * Create a live text buffer seeded from an offline text buffer.
   */
  createLiveTextBufferFromOffline(offlineBufferId: string): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    totalCharsWritten: number;
    revision: number;
    segmentCount: number;
    spoolMode?: string;
    spoolEnabled?: boolean;
    spoolReady?: boolean;
    spoolBytes?: number;
    spoolPath?: string;
  }>;

  /**
   * Finalize a live text buffer (recording → finished).
   */
  finalizeLiveTextBuffer(liveBufferId: string): Promise<void>;

  /**
   * Get info for any pipeline text buffer (offline or live).
   */
  getPipelineTextBufferInfo(bufferId: string): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    utf16Length?: number;
    tokenCount?: number;
    timestampCount?: number;
    durationCount?: number;
    hasLang?: boolean;
    hasEmotion?: boolean;
    hasEvent?: boolean;
    totalCharsWritten?: number;
    revision?: number;
    segmentCount?: number;
    spoolMode?: string;
    spoolEnabled?: boolean;
    spoolReady?: boolean;
    spoolBytes?: number;
    spoolPath?: string;
  }>;

  /**
   * Release any pipeline text buffer (offline or live).
   */
  releasePipelineTextBuffer(bufferId: string): Promise<void>;

  /**
   * Get a slice of hypothesis text from an offline text buffer.
   */
  getOfflineTextBufferTextSlice(
    bufferId: string,
    startUtf16: number,
    maxUtf16: number
  ): Promise<string>;

  /**
   * Get a slice of tokens from an offline text buffer.
   */
  getOfflineTextBufferTokensSlice(
    bufferId: string,
    start: number,
    maxCount: number
  ): Promise<string[]>;

  /**
   * Get a slice of timestamps from an offline text buffer.
   */
  getOfflineTextBufferTimestampsSlice(
    bufferId: string,
    start: number,
    maxCount: number
  ): Promise<number[]>;

  /**
   * Get a slice of durations from an offline text buffer.
   */
  getOfflineTextBufferDurationsSlice(
    bufferId: string,
    start: number,
    maxCount: number
  ): Promise<number[]>;

  /**
   * Get the language string from an offline text buffer.
   */
  getOfflineTextBufferLang(bufferId: string): Promise<string>;

  /**
   * Get the emotion string from an offline text buffer.
   */
  getOfflineTextBufferEmotion(bufferId: string): Promise<string>;

  /**
   * Get the event string from an offline text buffer.
   */
  getOfflineTextBufferEvent(bufferId: string): Promise<string>;

  /**
   * Get a slice of partial text from a live text buffer (debug/UI).
   */
  getLiveTextBufferPartialSlice(
    liveBufferId: string,
    startUtf16: number,
    maxUtf16: number
  ): Promise<string>;

  /** Replace the current live text partial (public data-level write API). */
  setLiveTextBufferPartial(liveBufferId: string, text: string): Promise<void>;

  /** Append text to the current live text partial (public data-level write API). */
  appendLiveTextBufferPartial(
    liveBufferId: string,
    text: string
  ): Promise<void>;

  /** Commit a text segment to a live text buffer. */
  appendLiveTextSegment(
    liveBufferId: string,
    text: string,
    tokens?: string[],
    timestamps?: number[],
    meta?: Object
  ): Promise<{ segmentIndex: number }>;

  /** Read committed text segments from a live text buffer by index window. */
  getLiveTextBufferSegments(
    liveBufferId: string,
    startIndex: number,
    maxCount: number,
    options?: {
      includeTokens?: boolean;
      includeTimestamps?: boolean;
      includeMeta?: boolean;
    }
  ): Promise<{
    segments: Array<{
      text: string;
      source: string;
      segmentIndex: number;
      tokens?: string[];
      timestamps?: number[];
      meta?: Object;
    }>;
  }>;

  /** Return number of committed segments currently retained in the live segment log. */
  getLiveTextBufferSegmentCount(liveBufferId: string): Promise<number>;

  // ==================== Segmentation Engine Core ====================

  /** Attach a segmentation engine to a live text/audio buffer. */
  attachSegmentationEngine(
    bufferId: string,
    domain: 'text' | 'speech',
    policy: Object
  ): Promise<{
    engineId: string;
    attachedBufferId: string;
    domain: 'text' | 'speech';
    policy: Object;
    state: 'active' | 'detached';
    totalSegmentsCommitted: number;
    lastSegmentId?: string;
    segmentBufferId?: string;
  }>;

  /** Detach a segmentation engine and optionally flush final pending data. */
  detachSegmentationEngine(
    engineId: string,
    flushFinal?: boolean
  ): Promise<void>;

  /** Get segmentation engine runtime info. */
  getSegmentationEngineInfo(engineId: string): Promise<{
    engineId: string;
    attachedBufferId: string;
    domain: 'text' | 'speech';
    policy: Object;
    state: 'active' | 'detached';
    totalSegmentsCommitted: number;
    lastSegmentId?: string;
    segmentBufferId?: string;
  }>;

  /** One-shot offline segmentation pass. */
  segmentOfflineBuffer(
    bufferId: string,
    domain: 'text' | 'speech',
    policy: Object
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    segmentCount?: number;
    sourceAudioBufferId?: string;
    segments?: Array<{
      segmentId: string;
      startOffset: number;
      endOffset: number;
      reason: string;
      source: string;
      text: string;
    }>;
  }>;

  // ==================== Pipeline Segment Buffers ====================

  createLiveSegmentBuffer(options: {
    sourceAudioBufferId?: string;
    maxSegments?: number;
    spoolingMode?: string;
    spoolingPath?: string;
    spoolingTemporary?: boolean;
    spoolingThresholdBytes?: number;
    /** When true, emit `pipelineLiveSegmentAppended` for each new segment. */
    emitSegmentAppendedEvents?: boolean;
    /** Optional throttle (ms) for segment-appended events. */
    segmentEventMinIntervalMs?: number;
  }): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    segmentCount?: number;
    totalSegmentsWritten?: number;
    sourceAudioBufferId?: string;
    spoolMode?: string;
    spoolEnabled?: boolean;
    spoolReady?: boolean;
    spoolBytes?: number;
    spoolPath?: string;
  }>;

  createEmptyOfflineSegmentBuffer(options?: {
    sourceAudioBufferId?: string;
  }): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    segmentCount?: number;
    sourceAudioBufferId?: string;
  }>;

  appendLiveSegment(
    liveBufferId: string,
    kind: 'speech' | 'alignment',
    sourceAudioBufferId: string,
    startSample: number,
    endSample: number,
    sampleRate: number,
    durationMs?: number,
    confidence?: number,
    /**
     * Strict payload contract (validated in JS/native):
     * - kind='speech': payload.source must be one of 'vad' | 'stt' | 'tts'
     *   - source='vad' -> allowed keys: source, engine, decision, score
     *   - source='stt' -> allowed keys: source, transcript, tokenCount, isFinal
     *   - source='tts' -> allowed keys: source, text, chunkIndex, isFinalChunk
     * - kind='alignment': strict alignment payload contract
     */
    payload?: Object
  ): Promise<{ segmentId: string; segmentIndex: number }>;

  finalizeLiveSegmentBuffer(liveBufferId: string): Promise<void>;

  createOfflineSegmentBufferFromLive(
    liveBufferId: string,
    mode?: string
  ): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    segmentCount?: number;
    sourceAudioBufferId?: string;
  }>;

  populateOfflineSegmentBufferIfEmpty(
    targetBufferId: string,
    liveBufferId: string,
    mode?: string
  ): Promise<void>;

  getPipelineSegmentBufferInfo(bufferId: string): Promise<{
    bufferId: string;
    kind: string;
    state: string;
    segmentCount?: number;
    totalSegmentsWritten?: number;
    sourceAudioBufferId?: string;
    spoolMode?: string;
    spoolEnabled?: boolean;
    spoolReady?: boolean;
    spoolBytes?: number;
    spoolPath?: string;
  }>;

  getOfflineSegmentBufferSegments(
    bufferId: string,
    start?: number,
    maxCount?: number
  ): Promise<{
    segments: Array<{
      id: string;
      kind: 'speech' | 'alignment';
      sourceAudioBufferId: string;
      startSample: number;
      endSample: number;
      sampleRate: number;
      durationMs: number;
      confidence?: number;
      reason?: string;
      source?: string;
      createdAtMs?: number;
      payload?: Object;
    }>;
  }>;

  getLiveSegmentBufferSegments(
    liveBufferId: string,
    startIndex: number,
    maxCount: number
  ): Promise<{
    segments: Array<{
      id: string;
      kind: 'speech' | 'alignment';
      sourceAudioBufferId: string;
      startSample: number;
      endSample: number;
      sampleRate: number;
      durationMs: number;
      confidence?: number;
      reason?: string;
      source?: string;
      createdAtMs?: number;
      payload?: Object;
    }>;
  }>;

  getLiveSegmentBufferSegmentCount(liveBufferId: string): Promise<number>;

  releasePipelineSegmentBuffer(bufferId: string): Promise<void>;

  // ==================== Segment Link Maps ====================

  createSegmentLinkMap(options?: {
    textBufferId?: string;
    audioBufferId?: string;
  }): Promise<{ linkMapId: string }>;

  addSegmentLink(
    linkMapId: string,
    link: {
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }
  ): Promise<{
    linkId: string;
    textSegmentId: string;
    speechSegmentId: string;
    linkType: string;
    confidence?: number;
    meta?: Object;
  }>;

  addSegmentLinks(
    linkMapId: string,
    links: Array<{
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }>
  ): Promise<{
    links: Array<{
      linkId: string;
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }>;
  }>;

  removeSegmentLink(linkMapId: string, linkId: string): Promise<void>;

  getSpeechSegmentsForText(
    linkMapId: string,
    textSegmentId: string
  ): Promise<{
    links: Array<{
      linkId: string;
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }>;
  }>;

  getTextSegmentsForSpeech(
    linkMapId: string,
    speechSegmentId: string
  ): Promise<{
    links: Array<{
      linkId: string;
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }>;
  }>;

  getAllSegmentLinks(
    linkMapId: string,
    startIndex?: number,
    maxCount?: number
  ): Promise<{
    links: Array<{
      linkId: string;
      textSegmentId: string;
      speechSegmentId: string;
      linkType: string;
      confidence?: number;
      meta?: Object;
    }>;
  }>;

  getSegmentLinkCount(linkMapId: string): Promise<number>;

  getSegmentLinkMapInfo(linkMapId: string): Promise<{
    linkMapId: string;
    linkCount: number;
    textBufferId?: string;
    audioBufferId?: string;
  }>;

  releaseSegmentLinkMap(linkMapId: string): Promise<void>;

  // ==================== VAD Methods ====================

  initializeVad(instanceId: string, options: Object): Promise<void>;

  startVadPipeline(
    instanceId: string,
    audioInBufferId: string,
    segmentOutBufferId: string,
    options?: Object
  ): Promise<{ pipelineId: string }>;

  runVadOffline(
    instanceId: string,
    audioInBufferId: string,
    segmentOutBufferId: string,
    options?: Object
  ): Promise<{
    chunksProcessed: number;
    unitsRead: number;
    unitsWritten: number;
    segmentCount: number;
    speechDurationMs: number;
  }>;

  flushVad(pipelineId: string): Promise<void>;

  resetVad(pipelineId: string): Promise<void>;

  stopVadPipeline(pipelineId: string): Promise<void>;

  getVadPipelineStatus(pipelineId: string): Promise<{
    pipelineId: string;
    isRunning: boolean;
    isFlushing: boolean;
    queueDepth: number;
    chunksProcessed: number;
    unitsRead: number;
    unitsWritten: number;
    error: string | null;
  }>;

  isVadSpeechDetected(instanceId: string): Promise<boolean>;

  unloadVad(instanceId: string): Promise<void>;

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
   * Synthesize speech from a text buffer into an audio buffer (buffer-to-buffer pipeline).
   * The audioOut buffer must be empty (created via createEmptyOfflineAudioBuffer).
   * Its sampleRate must match the model output rate (strict, no resampling).
   * @param instanceId - TTS engine instance ID
   * @param textInBufferId - Offline text buffer ID (input text source)
   * @param audioOutBufferId - Empty offline audio buffer ID (output target)
   * @param options - Synthesis options (sid, speed, voiceClone, etc.)
   */
  synthesizeTts(
    instanceId: string,
    textInBufferId: string,
    audioOutBufferId: string,
    options?: Object
  ): Promise<void>;

  // ==================== Alignment / Subtitle Methods ====================

  /**
   * Standalone offline alignment from pipeline buffers (all modes).
   *
   * - `textInBufferId`: offline text buffer (`txt_off_*`)
   * - `audioInBufferId`: offline audio buffer (`off_*`)
   * - `segmentOutBufferId`: caller-provided offline segment buffer (`seg_off_*`)
   *
   * Text/audio buffers are read-only; alignment writes only into `segmentOutBufferId`.
   */
  alignOfflineTextToAudio(
    textInBufferId: string,
    audioInBufferId: string,
    segmentOutBufferId: string,
    mode: 'proportional' | 'estimated' | 'accurate' | 'vad',
    granularity: 'sentence' | 'word' | 'character',
    options?: Object
  ): Promise<{
    outputSegmentBufferId: string;
    segmentsWritten: number;
    warningCode?: string;
    vadAnchorCount?: number;
    minAnchorsApplied?: number;
  }>;

  /**
   * Accurate alignment on a single PCM slice.
   * Used by `asr_mediated` to align each linker-assigned anchor slice.
   */
  alignAccurateFromPcm(
    modelPath: string,
    text: string,
    pcm: {
      audioBufferId: string;
      startSample: number;
      sampleCount: number;
    },
    sampleRate: number,
    granularity: 'sentence' | 'word' | 'character',
    language?: string
  ): Promise<{
    subtitles: Array<{
      text: string;
      start: number;
      end: number;
    }>;
    timingMode: string;
  }>;

  /**
   * Forced CTC alignment on a single PCM slice + text window.
   * Used by `chunked_forced_ctc` to advance a cursor across anchors.
   */
  alignAccurateForcedCtcFromPcm(
    modelPath: string,
    windowText: string,
    pcm: {
      audioBufferId: string;
      startSample: number;
      sampleCount: number;
    },
    sampleRate: number,
    granularity: 'sentence' | 'word',
    language?: string
  ): Promise<{
    tokens: Array<{
      text: string;
      startMs: number;
      endMs: number;
    }>;
    consumedTokenCount: number;
    diagnostics?: {
      ctcBlankRatio?: number;
      framesProcessed?: number;
    };
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
   * Start a streaming TTS pipeline worker.
   * Reads committed segments from a LiveTextBuffer, synthesizes each one
   * (using per-segment meta overrides where available), and writes PCM
   * samples to a LiveAudioBuffer.
   */
  startTtsPipeline(
    instanceId: string,
    textInLiveBufferId: string,
    audioOutLiveBufferId: string,
    options?: Object
  ): Promise<{ pipelineId: string }>;

  /**
   * Create a standalone PCM player session.
   * @param playerId - Unique session ID (generated by JS)
   * @param audioBufferId - Pipeline audio buffer ID to play from
   * @param volume - Volume scale [0, 1]
   */
  createPcmPlayer(
    playerId: string,
    audioBufferId: string,
    volume: number
  ): Promise<void>;

  /** List available output devices for PCM playback routing. */
  listAvailableOutputDevices(): Promise<
    Array<{
      id: string;
      name: string;
      kind: string;
      selected: boolean;
      default: boolean;
      canSelect: boolean;
    }>
  >;

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
   * Seek a PCM player to a position in milliseconds.
   * @param playerId - Player session ID
   * @param positionMs - Target position in milliseconds
   */
  seekPcmPlayerToMs(playerId: string, positionMs: number): Promise<void>;

  /**
   * Restart a PCM player from the beginning.
   * @param playerId - Player session ID
   */
  restartPcmPlayer(playerId: string): Promise<void>;

  /**
   * Get the current playback position in milliseconds.
   * @param playerId - Player session ID
   */
  getPcmPlayerPositionMs(playerId: string): Promise<number>;

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
    isStreaming?: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    languages?: string[];
    quantization?: string;
    detectionSources?: string[];
  }>;

  detectVadModel(
    modelDir: string,
    assetName: string | null,
    modelType?: string | null
  ): Promise<{
    success: boolean;
    isStreaming?: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    languages?: string[];
    quantization?: string;
    detectionSources?: string[];
    paths?: {
      model?: string;
    };
  }>;

  /**
   * Punctuation model detection: offline (CT-Transformer) vs online (CNN-BiLSTM + bpe.vocab).
   * `isStreaming` is true when native detection resolves an online-compatible CNN-BiLSTM layout.
   */
  detectPunctuationModel(
    modelDir: string,
    assetName: string | null,
    modelType?: string | null
  ): Promise<{
    success: boolean;
    isStreaming?: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
    languages?: string[];
    quantization?: string;
    detectionSources?: string[];
    paths?: {
      ct_transformer?: string;
      cnn_bilstm?: string;
      bpe_vocab?: string;
    };
  }>;

  /**
   * Load sherpa-onnx `OfflinePunctuation` (CT-Transformer). Uses native detect with
   * `ct_transformer` only (no online/CNN auto-pick).
   */
  initializeOfflinePunctuation(
    instanceId: string,
    modelDir: string,
    modelType?: string | null,
    numThreads?: number,
    provider?: string,
    debug?: boolean
  ): Promise<{
    success: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
  }>;

  /**
   * Read full text from `textIn` offline buffer, run offline punctuation, write to empty `textOut`.
   */
  punctuateOfflineTextBuffers(
    instanceId: string,
    textInBufferId: string,
    textOutBufferId: string
  ): Promise<{ processingTimeMs: number }>;

  /**
   * Punctuate a plain string into caller-owned `textOut` (same populate rules as `punctuate`).
   */
  punctuateOfflineString(
    instanceId: string,
    plain: string,
    textOutBufferId: string
  ): Promise<{ processingTimeMs: number }>;

  /** Release native `OfflinePunctuation` for this instance. */
  unloadOfflinePunctuation(instanceId: string): Promise<void>;

  /**
   * Load sherpa-onnx `OnlinePunctuation` (CNN-BiLSTM + bpe.vocab).
   */
  initializeOnlinePunctuation(
    instanceId: string,
    modelDir: string,
    modelType?: string | null,
    numThreads?: number,
    provider?: string,
    debug?: boolean
  ): Promise<{
    success: boolean;
    error?: string;
    detectedModels: Array<{ type: string; modelDir: string }>;
    modelType?: string;
  }>;

  /** Punctuate one committed live-text chunk with an existing OnlinePunctuation instance. */
  processOnlinePunctuationChunk(
    instanceId: string,
    text: string
  ): Promise<{ punctuatedText: string; processingTimeMs: number }>;

  /** Release native `OnlinePunctuation` for this instance. */
  unloadOnlinePunctuation(instanceId: string): Promise<void>;

  // ==================== Punctuation Pipeline ====================

  /**
   * Start a live-offline punctuation pipeline: a segmentation engine drives the
   * live text input buffer, and offline punctuation runs per committed text segment.
   */
  startPunctuationOfflineLivePipeline(
    instanceId: string,
    textInLiveBufferId: string,
    textOutLiveBufferId: string,
    options: {
      attachedSegmentationEngineId: string;
      segmentLiveBufferId: string;
    }
  ): Promise<{ pipelineId: string }>;

  /**
   * Start a live-offline TTS pipeline: a segmentation engine drives the
   * live text input buffer, and offline TTS synthesizes each committed text segment,
   * writing audio chunks to the live audio output buffer.
   *
   * See: docs/migration/liveOverload/sub-05-tts-live-overload.md
   */
  startTtsOfflineLivePipeline(
    instanceId: string,
    textInLiveBufferId: string,
    audioOutLiveBufferId: string,
    options: {
      attachedSegmentationEngineId: string;
      /** Present when speech-domain segmentation mirrors into seg_live_*; omitted for text-domain engines. */
      segmentLiveBufferId?: string;
      sid?: number;
      speed?: number;
      referenceAudioBufferId?: string;
      referenceText?: string;
    }
  ): Promise<{ pipelineId: string }>;

  startStreamingPunctuationPipeline(
    instanceId: string,
    inputBufferId: string,
    outputBufferId: string
  ): Promise<{ pipelineId: string }>;

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

  enhanceOfflineAudioBuffers(
    instanceId: string,
    audioInBufferId: string,
    audioOutBufferId: string
  ): Promise<void>;

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

  unloadOnlineEnhancement(instanceId: string): Promise<void>;

  // ==================== Enhancement Pipeline ====================

  startEnhancementPipeline(
    instanceId: string,
    inputBufferId: string,
    outputBufferId: string
  ): Promise<{ pipelineId: string }>;

  // ==================== Streaming Pipeline Control (generic) ====================

  stopStreamingPipeline(pipelineId: string): Promise<void>;

  flushStreamingPipeline(pipelineId: string): Promise<void>;

  resetStreamingPipeline(pipelineId: string): Promise<void>;

  getStreamingPipelineStatus(pipelineId: string): Promise<{
    pipelineId: string;
    isRunning: boolean;
    chunksProcessed: number;
    unitsRead: number;
    unitsWritten: number;
    error: string | null;
  }>;

  // ==================== File I/O ====================

  /**
   * Copy file from source to destination.
   * @param source - Serialized FileSource (ReadableMap with `kind` discriminator)
   * @param destination - Serialized FileDestination (ReadableMap with `kind` discriminator)
   * @param overwrite - Overwrite existing file at destination
   * @param createParentDirectories - Create parent dirs for fs/app destinations
   * @param operationId - Unique ID for progress events and cancellation
   * @returns { bytesCopied: number, outputKind: string, outputPath: string }
   */
  copyFile(
    source: Object,
    destination: Object,
    overwrite: boolean,
    createParentDirectories: boolean,
    operationId: string
  ): Promise<{
    bytesCopied: number;
    outputKind: string;
    outputPath: string;
  }>;

  /**
   * Write text to a destination.
   * @returns { outputKind: string, outputPath: string }
   */
  saveText(
    text: string,
    destination: Object,
    encoding: string,
    overwrite: boolean
  ): Promise<{
    outputKind: string;
    outputPath: string;
  }>;

  /**
   * Open system share sheet for source file.
   */
  shareFile(source: Object, mimeType: string, title: string): Promise<void>;

  /**
   * Cancel an in-progress file I/O operation by operationId.
   */
  cancelFileIO(operationId: string): Promise<void>;

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

  // ==================== Helper - Audio save ====================

  /**
   * Save a pipeline audio buffer to an encoded file via AudioEncodeSession.
   * File-backed inputs are decoded via AudioDecodeSession first.
   * Direct PCM inputs are fed to the encoder in chunks without decode.
   *
   * @param bufferId - "off_*" or "live_*" (must be finalized if live)
   * @param destination - Serialized FileDestination
   * @param format - Target format string (wav, mp3, flac, etc.)
   * @param outputSampleRateHz - 0 = format-dependent default
   * @param bitrate - Target bitrate in kbps (0 = codec default or quality-derived)
   * @param quality - 0=default, 1=low, 2=medium, 3=high
   * @param operationId - For progress/cancel correlation
   */
  saveAudioBufferToFile(
    bufferId: string,
    destination: Object,
    format: string,
    outputSampleRateHz: number,
    bitrate: number,
    quality: number,
    operationId: string
  ): Promise<{
    outputKind: string;
    outputPath: string;
  }>;

  /**
   * Encode a source audio file to an output file via AudioDecodeSession → AudioEncodeSession.
   * No buffer registry involvement — direct file-to-file pipeline.
   *
   * @param source - Serialized FileSource
   * @param destination - Serialized FileDestination
   * @param format - Target format string (wav, mp3, flac, etc.)
   * @param outputSampleRateHz - 0 = format-dependent default
   * @param bitrate - Target bitrate in kbps (0 = codec default or quality-derived)
   * @param quality - 0=default, 1=low, 2=medium, 3=high
   * @param operationId - For progress/cancel correlation
   */
  saveFileAsAudioFile(
    source: Object,
    destination: Object,
    format: string,
    outputSampleRateHz: number,
    bitrate: number,
    quality: number,
    operationId: string
  ): Promise<{
    outputKind: string;
    outputPath: string;
  }>;

  /**
   * Cancel a running audio save operation.
   */
  cancelAudioSave(operationId: string): Promise<void>;

  // ==================== FileSource helpers ====================

  /**
   * Return the absolute filesystem path for an {@link AppBaseDir} name.
   * Used by detect utilities to resolve `{ kind: 'app', base, path }` sources.
   *
   * Android: cache -> Context.cacheDir, documents -> filesDir/docs, files -> filesDir,
   *          tmp -> cacheDir/tmp, externalFiles -> getExternalFilesDir(null).
   * iOS:     cache -> NSCachesDirectory, documents -> NSDocumentDirectory,
   *          files -> NSApplicationSupportDirectory, tmp -> NSTemporaryDirectory.
   *
   * Rejects with `FILEIO_*` errors (e.g. `FILEIO_UNSUPPORTED_ON_PLATFORM`,
   * `FILEIO_UNSUPPORTED_LOCATION_KIND`, `FILEIO_WRITE_ERROR`, `FILEIO_RESOLVE_ERROR`).
   */
  resolveAppBaseDir(base: string): Promise<string>;

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

  // ── Pipeline Audio Session Coordinator ───────────────────────────────

  /** Configure the pipeline audio session coordinator policy. */
  configurePipelineAudioSession(config: {
    keepActiveWhenIdle?: boolean;
  }): Promise<void>;

  /** Set global audio route preference (applied to all active and future sessions). */
  setPipelineAudioRoutePreference(
    inputDeviceId: string | null,
    outputDeviceId: string | null
  ): Promise<void>;

  /** Clear global audio route preference, reverting to system defaults. */
  clearPipelineAudioRoutePreference(): Promise<void>;

  /** Get a snapshot of the current pipeline audio session state. */
  getPipelineAudioSessionState(): Promise<Object>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
