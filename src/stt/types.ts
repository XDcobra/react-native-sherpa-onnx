import type { ModelPathConfig } from '../types';

/**
 * Supported STT model types.
 */
export type STTModelType =
  | 'transducer'
  | 'zipformer'
  | 'paraformer'
  | 'nemo_ctc'
  | 'whisper'
  | 'wenet_ctc'
  | 'sense_voice'
  | 'funasr_nano'
  | 'auto';

/**
 * STT-specific initialization options
 */
export interface STTInitializeOptions {
  /**
   * Model directory path configuration
   */
  modelPath: ModelPathConfig;

  /**
   * Model quantization preference
   * - true: Prefer int8 quantized models (model.int8.onnx) - smaller, faster
   * - false: Prefer regular models (model.onnx) - higher accuracy
   * - undefined: Try int8 first, then fall back to regular (default behavior)
   */
  preferInt8?: boolean;

  /**
   * Explicit model type specification for STT models
   * - 'transducer': Force detection as Transducer model
   * - 'zipformer': Force detection as Zipformer (streaming) model
   * - 'paraformer': Force detection as Paraformer model
   * - 'nemo_ctc': Force detection as NeMo CTC model
   * - 'whisper': Force detection as Whisper model
   * - 'wenet_ctc': Force detection as WeNet CTC model
   * - 'sense_voice': Force detection as SenseVoice model
   * - 'funasr_nano': Force detection as FunASR Nano model
   * - 'auto': Automatic detection based on files (default)
   */
  modelType?: STTModelType;
}

/**
 * Transcription result
 */
export interface TranscriptionResult {
  /**
   * Transcribed text
   */
  text: string;
}
