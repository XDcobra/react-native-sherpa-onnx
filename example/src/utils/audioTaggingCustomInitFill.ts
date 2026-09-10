import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectAudioTaggingModel,
  type AudioTaggingCustomPathKey,
  type AudioTaggingModelType,
} from 'react-native-sherpa-onnx/audio-tagging';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import type { AudioTaggingCustomInitFormState } from '../components/modelInit/AudioTaggingCustomInitForm';

export type FillAudioTaggingCustomConfigResult = {
  modelType: AudioTaggingModelType;
  customConfig: Partial<Record<AudioTaggingCustomPathKey, FileSource>>;
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

export async function fillAudioTaggingCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillAudioTaggingCustomConfigResult> {
  const detectResult = await detectAudioTaggingModel(modelSource, {
    modelType: 'auto',
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const modelType: AudioTaggingModelType =
    detectResult.modelType === 'zipformer' ? 'zipformer' : 'ced';
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const detectPaths = detectResult.paths as
    | { model?: string; labels?: string }
    | undefined;

  const schema = await getCustomModelPathRequirements(
    ModelCategory.AudioTagging,
    modelType
  );
  const customConfig: Partial<Record<AudioTaggingCustomPathKey, FileSource>> =
    {};
  for (const field of schema.fields) {
    const key = field.key as AudioTaggingCustomPathKey;
    const fromDetect =
      key === 'model'
        ? detectPaths?.model
        : key === 'labels'
        ? detectPaths?.labels
        : undefined;
    const source = toFsSource(fromDetect);
    if (source) {
      customConfig[key] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as AudioTaggingCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}

export function emptyAudioTaggingCustomInitFormState(): AudioTaggingCustomInitFormState {
  return { modelType: 'ced', fileSources: {} };
}
