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
   */
  initializeSherpaOnnx(
    modelDir: string,
    preferInt8?: boolean,
    modelType?: string
  ): Promise<void>;

  /**
   * Transcribe an audio file.
   * Phase 1: Stub implementation.
   */
  transcribeFile(filePath: string): Promise<string>;

  /**
   * Release sherpa-onnx resources.
   */
  unloadSherpaOnnx(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');
