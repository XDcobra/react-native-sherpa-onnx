import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { detectKwsModel } from 'react-native-sherpa-onnx/kws';
import type {
  KwsCustomInitFormState,
  KwsCustomPathKey,
} from '../components/modelInit';

export async function fillKwsCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<{ customConfig: Partial<Record<KwsCustomPathKey, FileSource>> }> {
  const det = await detectKwsModel(modelSource);
  if (!det.success) {
    throw new Error(det.error ?? 'detectKwsModel failed');
  }
  const paths = det.paths ?? {};
  const customConfig: Partial<Record<KwsCustomPathKey, FileSource>> = {};
  const keys: KwsCustomPathKey[] = [
    'encoder',
    'decoder',
    'joiner',
    'tokens',
    'keywords',
  ];
  for (const key of keys) {
    const p = paths[key]?.trim();
    if (p) {
      customConfig[key] = { kind: 'fs', path: p };
    }
  }
  return { customConfig };
}

export function emptyKwsCustomInitFormState(): KwsCustomInitFormState {
  return { modelType: 'transducer', fileSources: {} };
}
