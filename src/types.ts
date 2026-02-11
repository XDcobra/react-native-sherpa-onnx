/**
 * Model path configuration options
 */
export type ModelPathConfig =
  | {
      /**
       * Path type: 'asset' - Model is bundled in app assets
       * On iOS: Bundle path (e.g., "models/sherpa-onnx-model")
       * On Android: Asset path (e.g., "models/sherpa-onnx-model")
       */
      type: 'asset';
      path: string;
    }
  | {
      /**
       * Path type: 'file' - Model is in file system
       * Absolute path to model directory
       */
      type: 'file';
      path: string;
    }
  | {
      /**
       * Path type: 'auto' - Automatically detect path type
       * Tries asset first, then file system
       */
      type: 'auto';
      path: string;
    };
