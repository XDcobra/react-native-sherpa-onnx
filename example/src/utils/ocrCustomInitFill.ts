import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectOcrModel,
  type OcrConcreteModelType,
  type OcrCustomPathKey,
} from 'react-native-sherpa-onnx/ocr';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import type { OcrCustomInitFormState } from '../components/modelInit/OcrCustomInitForm';

export type FillOcrCustomConfigResult = {
  modelType: OcrConcreteModelType;
  customConfig: Partial<Record<OcrCustomPathKey, FileSource>>;
  missingKeys: readonly string[];
  modelDir: string;
};

function toFsSource(path: string | undefined): FileSource | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function concreteFromDetect(
  modelType: string | undefined
): OcrConcreteModelType {
  if (
    modelType === 'doctr' ||
    modelType === 'doc_vlm' ||
    modelType === 'nemotron_parse' ||
    modelType === 'paddleocr_vl' ||
    modelType === 'ppocr'
  ) {
    return modelType;
  }
  return 'ppocr';
}

export async function fillOcrCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillOcrCustomConfigResult> {
  const detectResult = await detectOcrModel(modelSource, {
    modelType: 'auto',
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const modelType = concreteFromDetect(detectResult.modelType);
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const detectPaths = (detectResult.paths ?? {}) as Partial<
    Record<OcrCustomPathKey, string>
  >;

  const schema = await getCustomModelPathRequirements(
    ModelCategory.Ocr,
    modelType
  );
  const customConfig: Partial<Record<OcrCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const key = field.key as OcrCustomPathKey;
    const source = toFsSource(detectPaths[key]);
    if (source) {
      customConfig[key] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as OcrCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}

export function emptyOcrCustomInitFormState(): OcrCustomInitFormState {
  return { modelType: 'ppocr', fileSources: {}, maxNewTokens: 0, maxPixels: 0 };
}
