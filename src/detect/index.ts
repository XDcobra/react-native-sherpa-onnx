/**
 * Unified model detection and FileSource → native model input resolution.
 *
 * Import from `react-native-sherpa-onnx/detect`.
 * User guide: `docs/model-detect.md` in the package repo.
 *
 * - {@link detectModel} / {@link detectModelsBatch} — category + type (native C++)
 * - {@link resolveFileSourceForDetect} — `FileSource` → `modelDir` + `assetName` (not in `fileio`)
 */

export {
  resolveFileSourceForDetect,
  resolveFileSourceForModelInit,
  type ResolvedDetectInput,
} from './resolveModelInput';

export {
  detectModel,
  detectModelsBatch,
  detectModelResultMatchesCategory,
  isQnnModelName,
  type DetectModelInput,
  type DetectModelMatchedResult,
  type DetectModelNameInput,
  type DetectModelResult,
  type DetectModelsBatchOptions,
} from './detectModel';
