import { ModelCategory } from '../types';

export function getAssetExtension(name: string): 'tar.bz2' | 'onnx' | null {
  if (name.endsWith('.tar.bz2')) return 'tar.bz2';
  if (name.endsWith('.onnx')) return 'onnx';
  return null;
}

export function stripAssetExtension(
  name: string,
  ext: 'tar.bz2' | 'onnx'
): string {
  const suffix = `.${ext}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function isAssetSupportedForCategory(
  category: ModelCategory,
  name: string,
  ext: 'tar.bz2' | 'onnx'
): boolean {
  const lower = name.toLowerCase();

  switch (category) {
    case ModelCategory.Tts:
      return ext === 'tar.bz2';
    case ModelCategory.Stt:
      return ext === 'tar.bz2' && !lower.includes('vad');
    case ModelCategory.Vad:
      return ext === 'onnx' && lower.includes('vad');
    case ModelCategory.Punctuation:
      return ext === 'tar.bz2' || ext === 'onnx';
    case ModelCategory.Diarization:
      return ext === 'tar.bz2';
    case ModelCategory.Enhancement:
      return ext === 'onnx';
    case ModelCategory.Separation:
      return ext === 'tar.bz2' || ext === 'onnx';
    case ModelCategory.SpeakerEmbedding:
      return ext === 'onnx';
    case ModelCategory.Qnn:
      return (
        ext === 'tar.bz2' &&
        lower.includes('sherpa-onnx-qnn') &&
        lower.includes('binary') &&
        lower.includes('seconds')
      );
    case ModelCategory.Alignment:
      return ext === 'tar.bz2';
    default:
      return false;
  }
}
